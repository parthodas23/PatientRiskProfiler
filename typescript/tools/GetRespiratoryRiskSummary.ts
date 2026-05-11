import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

const RESPIRATORY_KEYWORDS = [
  "sinusitis",
  "bronchitis",
  "otitis",
  "pharyngitis",
  "laryngitis",
  "pneumonia",
  "rhinitis",
  "tonsillitis",
  "tracheitis",
  "croup",
  "influenza",
  "respiratory",
  "upper respiratory",
  "ear infection",
];

type ConditionEntry = {
  name: string;
  status: "active" | "resolved";
  onsetDate: string;
  resolvedDate: string | null;
  durationDays: number | null;
};

function isRespiratory(name: string): boolean {
  const lower = name.toLowerCase();
  return RESPIRATORY_KEYWORDS.some((kw) => lower.includes(kw));
}

function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function monthsBetween(start: string, end: string): number {
  return Math.round(daysBetween(start, end) / 30);
}

type RiskLevel = "LOW" | "MODERATE" | "HIGH";

function assessRisk(chain: ConditionEntry[]): {
  level: RiskLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const total = chain.length;
  const activeCount = chain.filter((c) => c.status === "active").length;
  const hasChronicProgression = chain.some(
    (c) => c.status === "active" && c.name.toLowerCase().includes("chronic"),
  );

  // recurrence scoring
  if (total >= 4) {
    score += 2;
    reasons.push(
      `${total} respiratory episodes on record — high recurrence pattern.`,
    );
  } else if (total >= 2) {
    score += 1;
    reasons.push(`${total} respiratory episodes on record.`);
  } else {
    reasons.push("Single respiratory episode — no recurrence pattern.");
  }

  // chronic progression
  if (hasChronicProgression) {
    score += 2;
    const chronic = chain.find(
      (c) => c.status === "active" && c.name.toLowerCase().includes("chronic"),
    );
    if (chronic) {
      const monthsActive = monthsBetween(
        chronic.onsetDate,
        new Date().toISOString().slice(0, 10),
      );
      reasons.push(
        `Acute infection progressed to chronic condition ("${chronic.name}") — active for ~${monthsActive} months.`,
      );
    }
  }

  // any active conditions
  if (activeCount > 0 && !hasChronicProgression) {
    score += 1;
    reasons.push(`${activeCount} respiratory condition(s) currently active.`);
  }

  // gap analysis — rapid recurrence
  const sorted = [...chain].sort((a, b) =>
    a.onsetDate.localeCompare(b.onsetDate),
  );
  const shortGaps: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) continue;
    const gap = daysBetween(
      prev.resolvedDate ?? prev.onsetDate,
      curr.onsetDate,
    );
    if (gap < 90) {
      shortGaps.push(`"${prev.name}" → "${curr.name}" (${gap} days apart)`);
    }
  }
  if (shortGaps.length > 0) {
    score += 1;
    reasons.push(
      `Rapid re-infection detected (< 90 days between episodes): ${shortGaps.join("; ")}.`,
    );
  }

  const level: RiskLevel =
    score >= 4 ? "HIGH" : score >= 2 ? "MODERATE" : "LOW";

  return { level, reasons };
}

class GetRespiratoryRiskSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetRespiratoryRiskSummary",
      {
        description:
          "Analyzes a patient's full respiratory condition history to produce a clinical risk summary. Returns overall risk level (LOW/MODERATE/HIGH), recurrence count, chronic progression flags, and gap analysis between episodes.",
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
        if (!patientId) {
          patientId = NullUtilities.getOrThrow(
            FhirUtilities.getPatientIdIfContextExists(req),
          );
        }

        const bundle = await FhirClientInstance.search(req, "Condition", [
          `patient=${patientId}`,
          "_sort=onset-date",
        ]);

        if (!bundle?.entry?.length) {
          return McpUtilities.createTextResponse(
            "Respiratory Risk Summary: No condition data found for this patient.",
          );
        }

        const chain: ConditionEntry[] = [];

        for (const entry of bundle.entry) {
          const condition = entry.resource as fhirR4.Condition;
          const name =
            condition.code?.coding?.[0]?.display ??
            condition.code?.text ??
            "Unknown";

          if (!isRespiratory(name)) continue;

          const status =
            condition.clinicalStatus?.coding?.[0]?.code === "active"
              ? "active"
              : "resolved";

          const onsetDate = condition.onsetDateTime?.slice(0, 10);
          if (!onsetDate) continue;

          const resolvedDate =
            condition.abatementDateTime?.slice(0, 10) ?? null;

          const durationDays = resolvedDate
            ? daysBetween(onsetDate, resolvedDate)
            : null;

          chain.push({ name, status, onsetDate, resolvedDate, durationDays });
        }

        if (!chain.length) {
          return McpUtilities.createTextResponse(
            "Respiratory Risk Summary: No respiratory conditions found for this patient.",
          );
        }

        chain.sort((a, b) => a.onsetDate.localeCompare(b.onsetDate));

        const { level, reasons } = assessRisk(chain);

        const riskEmoji =
          level === "HIGH" ? "🔴" : level === "MODERATE" ? "🟡" : "🟢";

        const first = chain[0];
        const last = chain[chain.length - 1];
        const spanMonths =
          first && last ? monthsBetween(first.onsetDate, last.onsetDate) : 0;

        const lines: string[] = [];
        lines.push("Respiratory Infection Risk Summary");
        lines.push(`Overall Risk: ${riskEmoji} ${level}`);
        lines.push("");
        lines.push("Clinical Findings:");
        for (const r of reasons) {
          lines.push(`  • ${r}`);
        }

        lines.push("");
        lines.push("Episode Timeline:");
        for (const [i, c] of chain.entries()) {
          const statusIcon = c.status === "active" ? "🔴" : "✅";
          const duration =
            c.durationDays !== null ? `${c.durationDays} days` : "ongoing";
          lines.push(
            `  ${i + 1}. ${statusIcon} ${c.name} (${c.onsetDate}, ${duration})`,
          );
        }

        lines.push("");
        lines.push(
          `Observation window: ${first?.onsetDate ?? "unknown"} to ${last?.resolvedDate ?? "present"} (~${spanMonths} months)`,
        );
        lines.push("");
        lines.push(
          "Note: This summary is generated from structured FHIR condition data and is intended to support clinical review, not replace it.",
        );

        return McpUtilities.createTextResponse(lines.join("\n"));
      },
    );
  }
}

export const GetRespiratoryRiskSummaryToolInstance =
  new GetRespiratoryRiskSummaryTool();
