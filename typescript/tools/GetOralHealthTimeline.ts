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
  status: "active" | "resolved";
  onsetDate: string;
  resolvedDate: string | null;
  durationDays: number | null;
};

function isOral(name: string): boolean {
  const lower = name.toLowerCase();
  return ORAL_KEYWORDS.some((kw) => lower.includes(kw));
}

function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

class GetOralHealthTimelineTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetOralHealthTimeline",
      {
        description:
          "Returns a chronological timeline of all oral and dental conditions for a patient (caries, gingivitis, tooth infections, etc.), sorted by onset date. Shows status, duration, and flags any recurrences of the same condition.",
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
            "Oral Health Timeline: No condition data found for this patient.",
          );
        }

        const timeline: OralConditionEntry[] = [];

        for (const entry of bundle.entry) {
          const condition = entry.resource as fhirR4.Condition;

          const name =
            condition.code?.coding?.[0]?.display ??
            condition.code?.text ??
            "Unknown condition";

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

          timeline.push({
            name,
            status,
            onsetDate,
            resolvedDate,
            durationDays,
          });
        }

        if (!timeline.length) {
          return McpUtilities.createTextResponse(
            "Oral Health Timeline: No oral or dental conditions found for this patient.",
          );
        }

        timeline.sort((a, b) => a.onsetDate.localeCompare(b.onsetDate));

        // detect recurrences — same base condition name appearing more than once
        const nameCounts = new Map<string, number>();
        for (const c of timeline) {
          const base = c.name
            .toLowerCase()
            .replace(/\s*\(.*?\)/g, "")
            .trim();
          nameCounts.set(base, (nameCounts.get(base) ?? 0) + 1);
        }

        const lines: string[] = [];
        const activeCount = timeline.filter(
          (c) => c.status === "active",
        ).length;
        const recurringNames = [...nameCounts.entries()]
          .filter(([, count]) => count > 1)
          .map(([name]) => name);

        lines.push(
          `Oral Health Timeline (${timeline.length} conditions, ${activeCount} currently active):`,
        );
        lines.push("");

        for (const [i, c] of timeline.entries()) {
          const statusIcon =
            c.status === "active" ? "🔴 ACTIVE" : "✅ Resolved";
          const duration =
            c.durationDays !== null ? `${c.durationDays} days` : "ongoing";
          const resolved = c.resolvedDate ? `→ ${c.resolvedDate}` : "→ present";

          const base = c.name
            .toLowerCase()
            .replace(/\s*\(.*?\)/g, "")
            .trim();
          const recurFlag = recurringNames.includes(base)
            ? " 🔁 RECURRENCE"
            : "";
          const connector = i < timeline.length - 1 ? "      ↓" : "";

          lines.push(`  [${i + 1}] ${c.name}${recurFlag}`);
          lines.push(
            `      ${statusIcon} | ${c.onsetDate} ${resolved} | Duration: ${duration}`,
          );
          if (connector) lines.push(connector);
        }

        if (recurringNames.length > 0) {
          lines.push("");
          lines.push("🔁 Recurrent conditions detected:");
          for (const name of recurringNames) {
            const instances = timeline.filter(
              (c) =>
                c.name
                  .toLowerCase()
                  .replace(/\s*\(.*?\)/g, "")
                  .trim() === name,
            );
            const dates = instances.map((c) => c.onsetDate).join(", ");
            lines.push(`  "${name}" appeared ${instances.length}x — ${dates}`);
          }
        }

        return McpUtilities.createTextResponse(lines.join("\n"));
      },
    );
  }
}

export const GetOralHealthTimelineToolInstance =
  new GetOralHealthTimelineTool();
