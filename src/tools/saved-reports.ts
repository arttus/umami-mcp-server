import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { errorResult, markdownTable, textResult, toJson, ResponseFormat } from "../format.js";
import { confirmField, responseFormatField, websiteField } from "../schemas.js";
import type { Paged, SavedReport } from "../types.js";

/**
 * Goals, funnels, journeys, retention, segments, and cohorts are not exposed by
 * Umami's documented REST API. They live behind the web UI as generic "reports"
 * (POST/GET/DELETE /api/reports), discovered by watching the UI's own network
 * calls since there is no public documentation for this endpoint. Each report
 * type shapes its own 'parameters' object differently, learned the same way:
 *   - goal:   { type: "url" | "event", value: string }
 *   - funnel: { steps: [{ type: "path" | "event", value: string, filters: [] }], window: number }
 * This is unofficial and could change without notice on a future Umami version.
 */

const savedReportTypeField = z
  .enum(["goal", "funnel", "journey", "retention", "segment", "cohort"])
  .describe("Report type, matching the sidebar section it appears under in the Umami UI.");

function reportToRow(report: SavedReport) {
  return {
    id: report.id,
    name: report.name,
    type: report.type,
    parameters: report.parameters,
    created_at: report.createdAt,
  };
}

export function registerSavedReportTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_create_goal",
    {
      title: "Create a goal visible in the Umami UI",
      description: `Create a persisted Goal that appears under Behavior > Goals in the Umami web UI, not just a computed result. Unlike umami_get_goal (which computes a conversion rate on demand and shows nothing in the UI), this saves the goal definition so it shows up for anyone browsing the dashboard.

Args:
  - website (string, optional): Website ID, name, or domain.
  - name (string, required): Display name for the goal.
  - match_type ('path' | 'event', required): Whether the goal is reaching a page or firing a custom event.
  - value (string, required): The page path (e.g. '/thank-you') or event name (e.g. 'signup') to match.

Returns:
  { "id": string, "name": string, "type": "goal", "parameters": object }

Error handling:
  - match_type='event' accepts any event name, even one that has never fired yet; the goal will just show 0 conversions until it does.`,
      inputSchema: {
        website: websiteField,
        name: z.string().min(1).describe("Display name for the goal."),
        match_type: z.enum(["path", "event"]).describe("Whether the goal matches a page path or a custom event."),
        value: z.string().min(1).describe("Page path (e.g. '/thank-you') or event name (e.g. 'signup')."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ website, name, match_type, value }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const parameters =
          match_type === "path" ? { type: "url", value } : { type: "event", value };

        const created = await client.post<SavedReport>("/reports", {
          type: "goal",
          name,
          websiteId,
          description: "",
          parameters,
        });

        const label = await getWebsiteLabel(client, websiteId);
        return textResult(
          `Created goal "${created.name}" (${created.id}) for ${label}. ` +
            `Visible now at Behavior > Goals in the Umami UI.\n\n${toJson(reportToRow(created))}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_create_funnel",
    {
      title: "Create a funnel visible in the Umami UI",
      description: `Create a persisted Funnel that appears under Behavior > Funnels in the Umami web UI, not just a computed result. Unlike umami_get_funnel (which computes step conversion on demand and shows nothing in the UI), this saves the funnel definition so it shows up for anyone browsing the dashboard.

Args:
  - website (string, optional): Website ID, name, or domain.
  - name (string, required): Display name for the funnel.
  - steps (array, required): 2-8 ordered steps, each { type: 'path' | 'event', value: string }.
  - window_minutes (number): Minutes a session has to complete all steps in order, default 60.

Returns:
  { "id": string, "name": string, "type": "funnel", "parameters": object }

Examples:
  - "/ -> /audit -> audit_submit funnel" -> steps=[{type:'path',value:'/'},{type:'path',value:'/audit'},{type:'event',value:'audit_submit'}]`,
      inputSchema: {
        website: websiteField,
        name: z.string().min(1).describe("Display name for the funnel."),
        steps: z
          .array(
            z.object({
              type: z.enum(["path", "event"]),
              value: z.string().min(1),
            })
          )
          .min(2)
          .max(8)
          .describe("Ordered steps: page paths or event names."),
        window_minutes: z.number().int().min(1).max(1440).default(60).describe("Session completion window, in minutes."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ website, name, steps, window_minutes }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);

        const created = await client.post<SavedReport>("/reports", {
          type: "funnel",
          name,
          websiteId,
          description: "",
          parameters: {
            steps: steps.map((step) => ({ type: step.type, value: step.value, filters: [] })),
            window: window_minutes,
          },
        });

        const label = await getWebsiteLabel(client, websiteId);
        return textResult(
          `Created funnel "${created.name}" (${created.id}) for ${label}. ` +
            `Visible now at Behavior > Funnels in the Umami UI.\n\n${toJson(reportToRow(created))}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_list_saved_reports",
    {
      title: "List saved goals, funnels, journeys, retention, segments, or cohorts",
      description: `List the saved reports of one type for a website, as they appear in the Umami UI sidebar (Goals, Funnels, Journeys, Retention, Segments, Cohorts).

Args:
  - website (string, optional): Website ID, name, or domain.
  - type (string, required): One of 'goal', 'funnel', 'journey', 'retention', 'segment', 'cohort'.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "reports": [ { "id": string, "name": string, "type": string, "parameters": object, "created_at": string } ] }`,
      inputSchema: {
        website: websiteField,
        type: savedReportTypeField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, type, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const result = await client.get<Paged<SavedReport>>("/reports", { websiteId, type });
        const reports = (result?.data ?? []).map(reportToRow);

        if (reports.length === 0) {
          return textResult(`No saved '${type}' reports for this website yet.`);
        }

        if (response_format === ResponseFormat.JSON) return textResult(toJson({ reports }));

        const label = await getWebsiteLabel(client, websiteId);
        const table = markdownTable(
          ["ID", "Name", "Parameters"],
          reports.map((r) => [r.id, r.name, JSON.stringify(r.parameters)])
        );
        return textResult(`# ${label}: saved ${type}s\n\n${table}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_delete_saved_report",
    {
      title: "Delete a saved goal, funnel, journey, retention, segment, or cohort",
      description: `Permanently delete a saved report (goal, funnel, journey, retention, segment, or cohort) so it no longer appears in the Umami UI. Get the report ID from umami_list_saved_reports.

This cannot be undone. Requires confirm=true.

Args:
  - report_id (string, required): The report's ID.
  - confirm (boolean, required): Must be true. There is no undo.

Returns:
  { "ok": true, "report_id": string }`,
      inputSchema: {
        report_id: z.string().min(1).describe("The report's ID, from umami_list_saved_reports."),
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ report_id, confirm }) => {
      if (confirm !== true) {
        return errorResult("Error: confirm must be true. This permanently deletes the saved report.");
      }
      try {
        await client.delete(`/reports/${report_id}`);
        return textResult(toJson({ ok: true, report_id }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
