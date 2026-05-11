import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

// keywords that identify respiratory conditions
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

function isRespiratory(displayName: string): boolean {
  const lower = displayName.toLowerCase();
  return RESPIRATORY_KEYWORDS.some((kw) => lower.includes(kw));
}

function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

class GetRespiratoryConditionChainTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetRespiratoryConditionChain",
      {
        description:
          "Returns a chronological chain of all respiratory-related conditions for a patient (sinusitis, bronchitis, otitis media, etc.), sorted by onset date. Shows status, duration, and flags any that became chronic.",
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
            "Respiratory Condition Chain: No condition data found for this patient.",
          );
        }

        const chain: ConditionEntry[] = [];

        for (const entry of bundle.entry) {
          const condition = entry.resource as fhirR4.Condition;

          const name =
            condition.code?.coding?.[0]?.display ??
            condition.code?.text ??
            "Unknown condition";

          if (!isRespiratory(name)) continue;

          const status =
            condition.clinicalStatus?.coding?.[0]?.code === "active"
              ? "active"
              : "resolved";

          const onsetDate = condition.onsetDateTime?.slice(0, 10) ?? null;

          if (!onsetDate) continue;

          const resolvedDate =
            condition.abatementDateTime?.slice(0, 10) ?? null;

          const durationDays = resolvedDate
            ? daysBetween(onsetDate, resolvedDate)
            : null;

          chain.push({
            name,
            status,
            onsetDate,
            resolvedDate,
            durationDays,
          });
        }

        if (!chain.length) {
          return McpUtilities.createTextResponse(
            "Respiratory Condition Chain: No respiratory conditions found for this patient.",
          );
        }

        // sort by onset date oldest first
        chain.sort((a, b) => a.onsetDate.localeCompare(b.onsetDate));

        const lines: string[] = [];
        const activeCount = chain.filter((c) => c.status === "active").length;

        lines.push(
          `Respiratory Condition Chain (${chain.length} conditions, ${activeCount} currently active):`,
        );
        lines.push("");

        for (const [i, c] of chain.entries()) {
          const statusIcon =
            c.status === "active" ? "🔴 ACTIVE" : "✅ Resolved";
          const duration =
            c.durationDays !== null ? `${c.durationDays} days` : "ongoing";
          const resolved = c.resolvedDate ? `→ ${c.resolvedDate}` : "→ present";

          const connector = i < chain.length - 1 ? "↓" : "";

          lines.push(`  [${i + 1}] ${c.name}`);
          lines.push(
            `      ${statusIcon} | ${c.onsetDate} ${resolved} | Duration: ${duration}`,
          );
          if (connector) lines.push(`      ${connector}`);
        }

        // flag chronic progression
        const active = chain.filter((c) => c.status === "active");
        if (active.length > 0) {
          lines.push("");
          lines.push("⚠️ Progression alert:");
          for (const a of active) {
            lines.push(
              `  "${a.name}" has been active since ${a.onsetDate} and is unresolved.`,
            );
          }
        }

        return McpUtilities.createTextResponse(lines.join("\n"));
      },
    );
  }
}

export const GetRespiratoryConditionChainToolInstance =
  new GetRespiratoryConditionChainTool();
