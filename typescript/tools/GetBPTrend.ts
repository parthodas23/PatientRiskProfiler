import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { FhirUtilities } from "../fhir-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

type BPReading = {
  date: string;
  systolic: number;
  diastolic: number;
  flag: "Elevated" | "Normal";
};

function classifyBP(systolic: number): BPReading["flag"] {
  return systolic > 130 ? "Elevated" : "Normal";
}

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
    if (code === "8480-6") systolic = val; // systolic LOINC
    if (code === "8462-4") diastolic = val; // diastolic LOINC
  }

  if (systolic === undefined || diastolic === undefined) return null;
  return { systolic, diastolic };
}

class GetBPTrendTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetBPTrend",
      {
        description:
          "Returns a patient's blood pressure history sorted by date, flagging any systolic reading above 130 as elevated. Useful for identifying sustained hypertension risk over time.",
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

        // LOINC 85354-9 = blood pressure panel
        const bundle = await FhirClientInstance.search(req, "Observation", [
          `patient=${patientId}`,
          "code=85354-9",
          "_sort=date",
        ]);

        if (!bundle?.entry?.length) {
          return McpUtilities.createTextResponse(
            "Blood Pressure History: No data found for this patient.",
          );
        }

        const readings: BPReading[] = [];

        for (const entry of bundle.entry) {
          const obs = entry.resource as fhirR4.Observation;
          const date = obs?.effectiveDateTime?.slice(0, 10);
          if (!date) continue;

          const bp = extractBPFromComponents(obs);
          if (!bp) continue;

          readings.push({
            date,
            systolic: bp.systolic,
            diastolic: bp.diastolic,
            flag: classifyBP(bp.systolic),
          });
        }

        if (!readings.length) {
          return McpUtilities.createTextResponse(
            "Blood Pressure History: Records found but no valid systolic/diastolic values could be extracted.",
          );
        }

        // sort oldest to newest
        readings.sort((a, b) => a.date.localeCompare(b.date));

        const lines: string[] = [];
        const elevatedCount = readings.filter(
          (r) => r.flag === "Elevated",
        ).length;

        lines.push(`Blood Pressure History (${readings.length} readings):`);
        for (const r of readings) {
          const flag = r.flag === "Elevated" ? "⚠️ Elevated" : "✅ Normal";
          lines.push(
            `  ${r.date}: ${r.systolic}/${r.diastolic} mmHg — ${flag}`,
          );
        }

        lines.push("");
        lines.push(
          `Elevated readings (systolic > 130): ${elevatedCount} of ${readings.length}`,
        );

        const latest = readings.at(-1);
        if (latest) {
          const latestFlag =
            latest.flag === "Elevated" ? "⚠️ Elevated" : "✅ Normal";
          lines.push(
            `Most recent: ${latest.systolic}/${latest.diastolic} mmHg (${latest.date}) — ${latestFlag}`,
          );
        }

        return McpUtilities.createTextResponse(lines.join("\n"));
      },
    );
  }
}

export const GetBPTrendToolInstance = new GetBPTrendTool();
