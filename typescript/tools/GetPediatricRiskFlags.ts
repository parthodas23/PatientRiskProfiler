import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

type RiskLevel = "LOW" | "MODERATE" | "HIGH";

type GrowthAnalysis = {
  totalReadings: number;
  flaggedReadings: number;
  consecutiveFlaggedRecent: number;
  latestPercentile: number | null;
  latestDate: string | null;
};

type BPAnalysis = {
  totalReadings: number;
  elevatedReadings: number;
  latestSystolic: number | null;
  latestDate: string | null;
};

function extractBPFromComponents(obs: fhirR4.Observation): {
  systolic: number;
  diastolic: number;
} | null {
  if (!obs.component?.length) return null;
  let systolic: number | undefined;
  let diastolic: number | undefined;
  for (const comp of obs.component) {
    const code = comp.code?.coding?.[0]?.code;
    const val = comp.valueQuantity?.value;
    if (val === undefined) continue;
    if (code === "8480-6") systolic = val;
    if (code === "8462-4") diastolic = val;
  }
  if (systolic === undefined || diastolic === undefined) return null;
  return { systolic, diastolic };
}

function analyzeGrowth(bundle: fhirR4.Bundle | null): GrowthAnalysis {
  const result: GrowthAnalysis = {
    totalReadings: 0,
    flaggedReadings: 0,
    consecutiveFlaggedRecent: 0,
    latestPercentile: null,
    latestDate: null,
  };

  if (!bundle?.entry?.length) return result;

  const readings = bundle.entry
    .map((e) => e.resource as fhirR4.Observation)
    .filter((o) => o?.valueQuantity?.value !== undefined)
    .map((o) => ({
      date: o.effectiveDateTime?.slice(0, 10) ?? "",
      value: o.valueQuantity!.value!,
    }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  result.totalReadings = readings.length;
  result.flaggedReadings = readings.filter((r) => r.value >= 85).length;

  // count consecutive flagged from most recent backwards
  const reversed = [...readings].reverse();
  for (const r of reversed) {
    if (r.value >= 85) result.consecutiveFlaggedRecent++;
    else break;
  }

  const latest = readings.at(-1);
  if (latest) {
    result.latestPercentile = latest.value;
    result.latestDate = latest.date;
  }

  return result;
}

function analyzeBP(bundle: fhirR4.Bundle | null): BPAnalysis {
  const result: BPAnalysis = {
    totalReadings: 0,
    elevatedReadings: 0,
    latestSystolic: null,
    latestDate: null,
  };

  if (!bundle?.entry?.length) return result;

  const readings: { date: string; systolic: number }[] = [];

  for (const entry of bundle.entry) {
    const obs = entry.resource as fhirR4.Observation;
    const date = obs?.effectiveDateTime?.slice(0, 10);
    if (!date) continue;
    const bp = extractBPFromComponents(obs);
    if (!bp) continue;
    readings.push({ date, systolic: bp.systolic });
  }

  readings.sort((a, b) => a.date.localeCompare(b.date));

  result.totalReadings = readings.length;
  result.elevatedReadings = readings.filter((r) => r.systolic > 130).length;

  const latest = readings.at(-1);
  if (latest) {
    result.latestSystolic = latest.systolic;
    result.latestDate = latest.date;
  }

  return result;
}

function calculateRisk(growth: GrowthAnalysis, bp: BPAnalysis): {
  level: RiskLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  // --- BMI scoring ---
  if (growth.totalReadings === 0) {
    reasons.push("No BMI percentile data available.");
  } else {
    const flaggedRatio = growth.flaggedReadings / growth.totalReadings;

    if (growth.consecutiveFlaggedRecent >= 3) {
      score += 2;
      reasons.push(
        `BMI has been at or above the 85th percentile for ${growth.consecutiveFlaggedRecent} consecutive recent readings.`
      );
    } else if (growth.flaggedReadings >= 2) {
      score += 1;
      reasons.push(
        `${growth.flaggedReadings} of ${growth.totalReadings} BMI readings were flagged as overweight or obese.`
      );
    } else {
      reasons.push("BMI percentile history within normal range.");
    }

    if (growth.latestPercentile !== null && growth.latestPercentile >= 95) {
      score += 1;
      reasons.push(
        `Latest BMI is at the 95th percentile or above (${growth.latestPercentile.toFixed(1)}th) — classified as obese.`
      );
    }
  }

  // --- BP scoring ---
  if (bp.totalReadings === 0) {
    reasons.push("No blood pressure data available.");
  } else {
    const elevatedRatio = bp.elevatedReadings / bp.totalReadings;

    if (elevatedRatio >= 0.7) {
      score += 2;
      reasons.push(
        `${bp.elevatedReadings} of ${bp.totalReadings} BP readings were elevated (systolic > 130) — sustained hypertensive pattern.`
      );
    } else if (bp.elevatedReadings >= 2) {
      score += 1;
      reasons.push(
        `${bp.elevatedReadings} of ${bp.totalReadings} BP readings were elevated.`
      );
    } else {
      reasons.push("Blood pressure readings largely within normal range.");
    }

    if (bp.latestSystolic !== null && bp.latestSystolic > 130) {
      score += 1;
      reasons.push(
        `Most recent BP reading (${bp.latestDate}) is elevated at ${bp.latestSystolic} mmHg systolic.`
      );
    }
  }

  // --- combined risk bonus ---
  if (
    growth.flaggedReadings >= 2 &&
    bp.elevatedReadings >= 2
  ) {
    score += 1;
    reasons.push(
      "Combined elevated BMI and elevated BP increases cardiovascular risk."
    );
  }

  const level: RiskLevel =
    score >= 4 ? "HIGH" : score >= 2 ? "MODERATE" : "LOW";

  return { level, reasons };
}

class GetPediatricRiskFlagsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetPediatricRiskFlags",
      {
        description:
          "Analyzes a pediatric patient's BMI percentile history and blood pressure trend together to produce an overall cardiovascular risk assessment: LOW, MODERATE, or HIGH. Returns the risk level and the specific reasons behind it.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional if patient context already exists."
            )
            .optional(),
        },
      },
      async ({ patientId }) => {
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req)
          );
        }

        // fetch both in parallel
        const [bmiBundle, bpBundle] = await Promise.all([
          FhirClientInstance.search(req, "Observation", [
            `patient=${patientId}`,
            "code=59576-9",
            "_sort=date",
          ]),
          FhirClientInstance.search(req, "Observation", [
            `patient=${patientId}`,
            "code=85354-9",
            "_sort=date",
          ]),
        ]);

        const growth = analyzeGrowth(bmiBundle);
        const bp = analyzeBP(bpBundle);
        const { level, reasons } = calculateRisk(growth, bp);

        const riskEmoji =
          level === "HIGH" ? "🔴" : level === "MODERATE" ? "🟡" : "🟢";

        const lines: string[] = [];
        lines.push(`Pediatric Cardiovascular Risk Assessment`);
        lines.push(`Overall Risk: ${riskEmoji} ${level}`);
        lines.push("");
        lines.push("Findings:");
        for (const reason of reasons) {
          lines.push(`  • ${reason}`);
        }

        lines.push("");

        if (growth.totalReadings > 0) {
          lines.push(
            `BMI data: ${growth.totalReadings} readings, ${growth.flaggedReadings} flagged` +
            (growth.latestPercentile !== null
              ? `, latest ${growth.latestPercentile.toFixed(1)}th percentile (${growth.latestDate})`
              : "")
          );
        }

        if (bp.totalReadings > 0) {
          lines.push(
            `BP data: ${bp.totalReadings} readings, ${bp.elevatedReadings} elevated` +
            (bp.latestSystolic !== null
              ? `, latest systolic ${bp.latestSystolic} mmHg (${bp.latestDate})`
              : "")
          );
        }

        lines.push("");
        lines.push(
          "Note: This assessment is generated from structured FHIR data and is intended to support clinical review, not replace it."
        );

        return McpUtilities.createTextResponse(lines.join("\n"));
      }
    );
  }
}

export const GetPediatricRiskFlagsTollInstance =
  new GetPediatricRiskFlagsTool();