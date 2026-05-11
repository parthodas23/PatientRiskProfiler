import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

const ORAL_KEYWORDS = [
  "dental",
  "caries",
  "gingivitis",
  "tooth",
  "teeth",
  "periodon",
  "oral",
  "mouth",
  "gum",
  "cavity",
  "abscess",
  "plaque",
  "enamel",
  "pulp",
  "root canal",
  "extraction",
  "orthodon",
];

type OralConditionEntry = {
  name: string;
  baseName: string;
  status: "active" | "resolved";
  onsetDate: string;
  resolvedDate: string | null;
  durationDays: number | null;
};

type RiskLevel = "LOW" | "MODERATE" | "HIGH";

function isOral(name: string): boolean {
  const lower = name.toLowerCase();
  return ORAL_KEYWORDS.some((kw) => lower.includes(kw));
}

function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function yearsBetween(start: string, end: string): number {
  return Math.round((daysBetween(start, end) / 365) * 10) / 10;
}

function assessOralRisk(timeline: OralConditionEntry[]): {
  level: RiskLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const total = timeline.length;
  const activeCount = timeline.filter((c) => c.status === "active").length;

  // group by base name to find recurrences
  const grouped = new Map<string, OralConditionEntry[]>();
  for (const c of timeline) {
    const existing = grouped.get(c.baseName) ?? [];
    existing.push(c);
    grouped.set(c.baseName, existing);
  }

  // recurrence scoring
  const recurring = [...grouped.entries()].filter(
    ([, entries]) => entries.length > 1,
  );

  if (recurring.length > 0) {
    for (const [name, instances] of recurring) {
      const sorted = [...instances].sort((a, b) =>
        a.onsetDate.localeCompare(b.onsetDate),
      );

      // gap between first and last recurrence
      const first = sorted[0];
      const last = sorted[sorted.length - 1];

      if (!first || !last) continue;

      const gapYears = yearsBetween(first.onsetDate, last.onsetDate);

      if (gapYears <= 2) {
        score += 2;
        reasons.push(
          `"${name}" recurred ${instances.length}x within ${gapYears} year(s) — rapid recurrence pattern.`,
        );
      } else {
        score += 1;
        reasons.push(
          `"${name}" recurred ${instances.length}x over ${gapYears} year(s) (${first.onsetDate} → ${last.onsetDate}).`,
        );
      }

      // check if recurrence followed closely after a related condition
      const firstOnset = first.onsetDate;
      const relatedBefore = timeline.filter(
        (c) =>
          c.baseName !== name &&
          c.onsetDate < firstOnset &&
          daysBetween(c.onsetDate, firstOnset) < 30,
      );
      if (relatedBefore.length > 0) {
        score += 1;
        reasons.push(
          `Initial "${name}" was preceded within 30 days by: ${relatedBefore
            .map((c) => `"${c.name}"`)
            .join(", ")} — suggests linked oral health episode.`,
        );
      }
    }
  } else if (total >= 3) {
    score += 1;
    reasons.push(
      `${total} distinct oral conditions recorded — no direct recurrence but multiple episodes.`,
    );
  } else if (total > 0) {
    reasons.push(
      `${total} oral condition(s) on record — no recurrence detected.`,
    );
  }

  // cluster detection — multiple conditions in short window
  const sorted = [...timeline].sort((a, b) =>
    a.onsetDate.localeCompare(b.onsetDate),
  );

  const clusters: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!prev || !curr) continue;
    const gap = daysBetween(prev.onsetDate, curr.onsetDate);
    if (gap <= 14) {
      clusters.push(`"${prev.name}" + "${curr.name}" (${gap} days apart)`);
    }
  }

  if (clusters.length > 0) {
    score += 1;
    reasons.push(
      `Condition cluster detected — multiple oral issues within 14 days: ${clusters.join("; ")}.`,
    );
  }

  // active conditions
  if (activeCount > 0) {
    score += 1;
    reasons.push(`${activeCount} oral condition(s) currently active.`);
  }

  if (total === 0) {
    reasons.push("No oral health conditions found for this patient.");
  }

  const level: RiskLevel =
    score >= 4 ? "HIGH" : score >= 2 ? "MODERATE" : "LOW";

  return { level, reasons };
}

class GetOralHealthRiskSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetOralHealthRiskSummary",
      {
        description:
          "Analyzes a patient's full oral and dental condition history to produce a clinical risk summary. Detects recurrences, condition clusters, and linked episodes. Returns overall risk level (LOW/MODERATE/HIGH) with specific clinical reasons.",
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
            "Oral Health Risk Summary: No condition data found for this patient.",
          );
        }

        const timeline: OralConditionEntry[] = [];

        for (const entry of bundle.entry) {
          const condition = entry.resource as fhirR4.Condition;
          const name =
            condition.code?.coding?.[0]?.display ??
            condition.code?.text ??
            "Unknown";

          if (!isOral(name)) continue;

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

          const baseName = name
            .toLowerCase()
            .replace(/\s*\(.*?\)/g, "")
            .trim();

          timeline.push({
            name,
            baseName,
            status,
            onsetDate,
            resolvedDate,
            durationDays,
          });
        }

        if (!timeline.length) {
          return McpUtilities.createTextResponse(
            "Oral Health Risk Summary: No oral or dental conditions found for this patient.",
          );
        }

        timeline.sort((a, b) => a.onsetDate.localeCompare(b.onsetDate));

        const { level, reasons } = assessOralRisk(timeline);

        const riskEmoji =
          level === "HIGH" ? "🔴" : level === "MODERATE" ? "🟡" : "🟢";

        const first = timeline[0];
        const last = timeline[timeline.length - 1];

        const lines: string[] = [];
        lines.push("Oral Health Risk Summary");
        lines.push(`Overall Risk: ${riskEmoji} ${level}`);
        lines.push("");
        lines.push("Clinical Findings:");
        for (const r of reasons) {
          lines.push(`  • ${r}`);
        }

        lines.push("");
        lines.push("Condition Timeline:");
        for (const [i, c] of timeline.entries()) {
          const statusIcon = c.status === "active" ? "🔴" : "✅";
          const duration =
            c.durationDays !== null ? `${c.durationDays} days` : "ongoing";
          lines.push(
            `  ${i + 1}. ${statusIcon} ${c.name} (${c.onsetDate}, ${duration})`,
          );
        }

        if (first && last) {
          const spanYears = yearsBetween(
            first.onsetDate,
            last.resolvedDate ?? new Date().toISOString().slice(0, 10),
          );
          lines.push("");
          lines.push(
            `Observation window: ${first.onsetDate} to ${last.resolvedDate ?? "present"} (~${spanYears} years)`,
          );
        }

        lines.push("");
        lines.push(
          "Note: This summary is generated from structured FHIR condition data and is intended to support clinical review, not replace it.",
        );

        return McpUtilities.createTextResponse(lines.join("\n"));
      },
    );
  }
}

export const GetOralHealthRiskSummaryToolInstance =
  new GetOralHealthRiskSummaryTool();
