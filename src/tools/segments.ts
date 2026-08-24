import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FILTER_KEYS } from "../constants.js";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { errorResult, markdownTable, textResult, toJson, ResponseFormat } from "../format.js";
import { confirmField, responseFormatField, websiteField } from "../schemas.js";
import type { Paged, SavedSegment } from "../types.js";

/**
 * Segments and cohorts (Audience section of the Umami UI) live on
 * /websites/:id/segments, a completely different resource from the /api/reports
 * family used for goals/funnels/journeys/retention (see saved-reports.ts).
 * Discovered the same way: watching the UI's own network calls, since neither
 * is in Umami's documented REST API. This is unofficial and could change
 * without notice on a future Umami version.
 *
 * Confirmed schema (POST/GET/DELETE /websites/:id/segments):
 *   segment: { filters: [{ name, value, operator }], match?: "all" | "any" }
 *   cohort:  { action: { type: "path" | "event", value }, filters: [...], dateRange, match? }
 * Only the "eq"/"neq" operators (UI's "Is"/"Is not") were confirmed by testing;
 * the UI also offers Contains/Does not contain/regex variants whose operator
 * strings were not captured, so they are not exposed here.
 */

const filterDimensionField = z
  .enum(FILTER_KEYS)
  .describe(`Dimension to filter on. One of: ${FILTER_KEYS.join(", ")}.`);

const segmentFilterField = z.object({
  dimension: filterDimensionField,
  is_not: z.boolean().default(false).describe("True for 'is not' instead of 'is'."),
  value: z.string().min(1).describe("Value to match, e.g. 'mobile', 'US', 'ig'."),
});

const matchField = z
  .enum(["all", "any"])
  .default("all")
  .describe("Whether every filter must match ('all') or just one ('any').");

const dateRangeField = z
  .enum(["7day", "30day", "90day", "6month", "12month"])
  .default("30day")
  .describe("Window in which the action must have occurred.");

function toApiFilters(filters: Array<{ dimension: string; is_not: boolean; value: string }>) {
  return filters.map((f) => ({ name: f.dimension, value: f.value, operator: f.is_not ? "neq" : "eq" }));
}

function segmentToRow(segment: SavedSegment) {
  return {
    id: segment.id,
    name: segment.name,
    type: segment.type,
    parameters: segment.parameters,
    created_at: segment.createdAt,
  };
}

export function registerSegmentTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_create_segment",
    {
      title: "Create a segment visible in the Umami UI",
      description: `Create a persisted audience Segment (a saved filter combination) that appears under Audience > Segments in the Umami UI.

Args:
  - website (string, optional): Website ID, name, or domain.
  - name (string, required): Display name for the segment.
  - filters (array, required): 1+ filters, each { dimension, value, is_not? }. Dimension is one of: ${FILTER_KEYS.join(", ")}.
  - match ('all' | 'any'): Whether every filter must match, or just one (default: 'all').

Returns:
  { "id": string, "name": string, "type": "segment", "parameters": object }

Examples:
  - "Mobile visitors" -> filters=[{dimension:'device', value:'mobile'}]
  - "Paid social, not from the US" -> filters=[{dimension:'utmMedium', value:'paid'}, {dimension:'country', value:'US', is_not:true}], match='all'`,
      inputSchema: {
        website: websiteField,
        name: z.string().min(1).describe("Display name for the segment."),
        filters: z.array(segmentFilterField).min(1).describe("1 or more filters."),
        match: matchField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ website, name, filters, match }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);

        const created = await client.post<SavedSegment>(`/websites/${websiteId}/segments`, {
          type: "segment",
          name,
          parameters: { filters: toApiFilters(filters), match },
        });

        const label = await getWebsiteLabel(client, websiteId);
        return textResult(
          `Created segment "${created.name}" (${created.id}) for ${label}. ` +
            `Visible now at Audience > Segments in the Umami UI.\n\n${toJson(segmentToRow(created))}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_create_cohort",
    {
      title: "Create a cohort visible in the Umami UI",
      description: `Create a persisted audience Cohort (visitors who performed an action within a date range, optionally filtered further) that appears under Audience > Cohorts in the Umami UI.

Args:
  - website (string, optional): Website ID, name, or domain.
  - name (string, required): Display name for the cohort.
  - action_type ('path' | 'event', required): Whether the qualifying action is a page view or a custom event.
  - action_value (string, required): The page path (e.g. '/audit') or event name (e.g. 'signup').
  - date_range ('7day'|'30day'|'90day'|'6month'|'12month'): Window the action must fall in, default '30day'.
  - filters (array, optional): Additional filters, each { dimension, value, is_not? }.
  - match ('all' | 'any'): Whether every filter must match, or just one (default: 'all').

Returns:
  { "id": string, "name": string, "type": "cohort", "parameters": object }

Examples:
  - "Visitors who viewed /audit in the last 30 days" -> action_type='path', action_value='/audit'
  - "Mobile visitors who fired 'signup' in the last 90 days" -> action_type='event', action_value='signup', date_range='90day', filters=[{dimension:'device', value:'mobile'}]`,
      inputSchema: {
        website: websiteField,
        name: z.string().min(1).describe("Display name for the cohort."),
        action_type: z.enum(["path", "event"]).describe("Whether the action is a page view or a custom event."),
        action_value: z.string().min(1).describe("Page path (e.g. '/audit') or event name (e.g. 'signup')."),
        date_range: dateRangeField,
        filters: z.array(segmentFilterField).default([]).describe("Additional filters, if any."),
        match: matchField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ website, name, action_type, action_value, date_range, filters, match }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);

        const created = await client.post<SavedSegment>(`/websites/${websiteId}/segments`, {
          type: "cohort",
          name,
          parameters: {
            action: { type: action_type, value: action_value },
            filters: toApiFilters(filters),
            dateRange: date_range,
            match,
          },
        });

        const label = await getWebsiteLabel(client, websiteId);
        return textResult(
          `Created cohort "${created.name}" (${created.id}) for ${label}. ` +
            `Visible now at Audience > Cohorts in the Umami UI.\n\n${toJson(segmentToRow(created))}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_list_segments_cohorts",
    {
      title: "List saved segments or cohorts",
      description: `List the saved Segments or Cohorts for a website, as they appear under Audience in the Umami UI.

Args:
  - website (string, optional): Website ID, name, or domain.
  - type ('segment' | 'cohort', required): Which kind to list.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "reports": [ { "id": string, "name": string, "type": string, "parameters": object, "created_at": string } ] }`,
      inputSchema: {
        website: websiteField,
        type: z.enum(["segment", "cohort"]),
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
        const result = await client.get<Paged<SavedSegment>>(`/websites/${websiteId}/segments`, { type });
        const reports = (result?.data ?? []).map(segmentToRow);

        if (reports.length === 0) {
          return textResult(`No saved '${type}s' for this website yet.`);
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
    "umami_delete_segment_cohort",
    {
      title: "Delete a saved segment or cohort",
      description: `Permanently delete a saved Segment or Cohort so it no longer appears in the Umami UI. Get the ID from umami_list_segments_cohorts.

This cannot be undone. Requires confirm=true.

Args:
  - website (string, optional): Website ID, name, or domain.
  - report_id (string, required): The segment/cohort's ID.
  - confirm (boolean, required): Must be true. There is no undo.

Returns:
  { "ok": true, "report_id": string }`,
      inputSchema: {
        website: websiteField,
        report_id: z.string().min(1).describe("The segment/cohort's ID, from umami_list_segments_cohorts."),
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, report_id, confirm }) => {
      if (confirm !== true) {
        return errorResult("Error: confirm must be true. This permanently deletes the saved segment or cohort.");
      }
      try {
        const websiteId = await resolveWebsiteId(client, website);
        await client.delete(`/websites/${websiteId}/segments/${report_id}`);
        return textResult(toJson({ ok: true, report_id }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
