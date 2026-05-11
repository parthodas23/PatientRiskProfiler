import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { differenceInYears, parseISO } from "date-fns";
import { NullUtilities } from "../null-utilities";
import { FhirClientInstance } from "../fhir-client";
import { fhirR4 } from "@smile-cdr/fhirts";
import { isAxiosError } from "axios";
import fs from "fs";
class PatientAgeTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GetPatientAge",
      {
        description: "Gets the age of a patient.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The id of the patient. This is optional if patient context already exists",
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

        const patient = await FhirClientInstance.read<fhirR4.Patient>(
          req,
          `Patient/${patientId}`,
        );
        if (!patient) {
          return McpUtilities.createTextResponse(
            "The patinet could not be found.",
            { isError: true },
          );
        }

        if (!patient.birthDate) {
          return McpUtilities.createTextResponse(
            "A birth date could not be found for the patient.",
            { isError: true },
          );
        }

        try {
          const date = parseISO(patient.birthDate);
          const age = differenceInYears(new Date(), date);

          // const supportedResources = ["Condition", "Observation"];

          // for (const resource of supportedResources) {
          //   const result = await FhirClientInstance.search(req, resource, [
          //     `patient=${patientId}`,
          //     `_count=100`,
          //   ]);
          //   const data =
          //     result?.entry?.map((e: fhirR4.BundleEntry) => e.resource) ?? [];
          //   fs.writeFileSync(
          //     `${resource}.json`,
          //     JSON.stringify(data, null, 2),
          //     "utf-8",
          //   );
          //   console.log(
          //     `✅ ${resource}: saved ${data.length} entries to ${resource}.json`,
          //   );
          // }
          return McpUtilities.createTextResponse(
            `The patient's age is: ${age}`,
          );
        } catch {
          return McpUtilities.createTextResponse(
            "Could not parse the patient's birth date.",
            { isError: true },
          );
        }
      },
    );
  }
}

export const PatientAgeToolInstance = new PatientAgeTool();
