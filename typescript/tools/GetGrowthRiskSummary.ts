import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

type BmiReading = {
  date: string;
  percentile: number;
  classification: "Normal" | "Overweight" | "Obese";
};

type MeasurementReading = {
  date: string;
  value: number;
  unit: string;
};

function classifyBmi(percentile: number): BmiReading["classification"] {
  if (percentile >= 95) return "Obese";
  if (percentile >= 85) return "Overweight";
  return "Normal";
}

function extractLatest(
  bundle: fhirR4.Bundle,
  loinc: string,
): MeasurementReading | null {
  const entries = (bundle.entry ?? [])
    .map((e) => e.resource as fhirR4.Observation)
    .filter(
      (o) =>
        o?.code?.coding?.some((c) => c.code === loinc) &&
        o.valueQuantity?.value !== undefined,
    )
    .sort((a, b) =>
      (b.effectiveDateTime ?? "").localeCompare(a.effectiveDateTime ?? ""),
    );

  const obs = entries[0];
  if (!obs) return null;

  return {
    date: (obs.effectiveDateTime ?? "").slice(0, 10),
    value: obs.valueQuantity!.value!,
    unit: obs.valueQuantity!.unit ?? "",
  };
}

class GetGrowthRiskSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetGrowthRiskSummary",
      {
        description:
          "Returns a pediatric patient's BMI percentile history with overweight/obese flags, plus latest height and weight. Useful for identifying sustained growth risk over time.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional if patient context already exists.",
            )
            .optional(),
        },
      },
      async ({ patientId }) => {
        // resolve patient ID
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req),
          );
        }

        // query 1: BMI percentile series (LOINC 59576-9)
        const bmiBundle = await FhirClientInstance.search(req, "Observation", [
          `patient=${patientId}`,
          "code=59576-9",
          "_sort=date",
        ]);

        // query 2: height (8302-2) and weight (29463-7) — latest only
        const hwBundle = await FhirClientInstance.search(req, "Observation", [
          `patient=${patientId}`,
          "code=8302-2,29463-7",
          "_sort=date",
        ]);

        // --- BMI percentile history ---
        const bmiReadings: BmiReading[] = [];

        if (bmiBundle?.entry?.length) {
          for (const entry of bmiBundle.entry) {
            const obs = entry.resource as fhirR4.Observation;
            const val = obs?.valueQuantity?.value;
            const date = obs?.effectiveDateTime?.slice(0, 10);
            if (val === undefined || !date) continue;

            bmiReadings.push({
              date,
              percentile: val,
              classification: classifyBmi(val),
            });
          }
        }

        // --- latest height and weight ---
        const latestHeight = hwBundle
          ? extractLatest(hwBundle, "8302-2")
          : null;
        const latestWeight = hwBundle
          ? extractLatest(hwBundle, "29463-7")
          : null;

        // --- build response text ---
        const lines: string[] = [];

        if (!bmiReadings.length) {
          lines.push("BMI Percentile History: No data found for this patient.");
        } else {
          lines.push(
            `BMI Percentile History (${bmiReadings.length} readings):`,
          );
          for (const r of bmiReadings) {
            const flag =
              r.classification === "Obese"
                ? "🔴 Obese"
                : r.classification === "Overweight"
                  ? "⚠️ Overweight"
                  : "✅ Normal";
            lines.push(
              `  ${r.date}: ${r.percentile.toFixed(1)}th percentile — ${flag}`,
            );
          }

          // count consecutive overweight/obese readings (latest streak)
          const flaggedCount = bmiReadings.filter(
            (r) => r.classification !== "Normal",
          ).length;
          if (flaggedCount > 0) {
            lines.push(
              `\nSummary: ${flaggedCount} of ${bmiReadings.length} readings flagged as Overweight or Obese.`,
            );
          }
        }

        lines.push("");

        if (latestHeight) {
          lines.push(
            `Latest height: ${latestHeight.value} ${latestHeight.unit} (${latestHeight.date})`,
          );
        } else {
          lines.push("Latest height: Not available.");
        }

        if (latestWeight) {
          lines.push(
            `Latest weight: ${latestWeight.value} ${latestWeight.unit} (${latestWeight.date})`,
          );
        } else {
          lines.push("Latest weight: Not available.");
        }

        return McpUtilities.createTextResponse(lines.join("\n"));
      },
    );
  }
}

export const GetGrowthRiskSummaryToolInstance = new GetGrowthRiskSummaryTool();
