import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { resolveRange } from "../services/dates.js";
import { ResponseFormat, errorResult, formatNumber, textResult, toJson } from "../format.js";
import {
  endDateField,
  filtersField,
  filtersToParams,
  rangeField,
  responseFormatField,
  startDateField,
  websiteField,
} from "../schemas.js";
import type { WebsiteStats } from "../types.js";
import { normalizeStats } from "./stats.js";

export function registerGoalTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_get_goal",
    {
      title: "Get conversion rate toward a goal",
      description: `Get the conversion rate for a single-step goal: visitors who reached a page, versus all visitors in the same range.

A goal is either a page ('path') or a custom event ('event'). Pass exactly one. Umami has no dedicated goals feature, so this is computed by comparing two filtered calls to the stats endpoint.

Args:
  - website (string, optional): Website ID, name, or domain.
  - path (string): Goal is reaching this page, e.g. '/thank-you'. Exactly one of path/event required.
  - event (string): Goal is firing this custom event, e.g. 'signup'. Exactly one of path/event required.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - filters (object, optional): Segment filters applied to both the goal and the baseline, e.g. { country: 'US' }.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "goal": { "type": "path"|"event", "value": string }, "baseline_visitors": number, "goal_visitors": number, "conversion_rate_pct": number }

Examples:
  - "What % of visitors reach the thank-you page?" -> path="/thank-you"
  - "Conversion rate on the signup event this month" -> event="signup", range="this_month"

Error handling:
  - A goal event with zero occurrences usually means the tracker never fired umami.track(event_name) in the range, not an error.`,
      inputSchema: {
        website: websiteField,
        path: z.string().min(1).optional().describe("Goal page path, e.g. '/thank-you'."),
        event: z.string().min(1).optional().describe("Goal custom event name, e.g. 'signup'."),
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        filters: filtersField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, path, event, range, start_date, end_date, filters, response_format }) => {
      if (!path && !event) {
        return errorResult("Error: pass either 'path' or 'event' to define the goal.");
      }
      if (path && event) {
        return errorResult("Error: pass only one of 'path' or 'event', not both.");
      }

      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({ range, start_date, end_date, timezone: client.timezone });
        const baseFilters = filtersToParams(filters);
        const goalFilters = { ...baseFilters, ...(path ? { path } : { event }) };

        const [baseline, goal] = await Promise.all([
          client
            .get<WebsiteStats>(`/websites/${websiteId}/stats`, {
              startAt: resolved.startAt,
              endAt: resolved.endAt,
              ...baseFilters,
            })
            .then(normalizeStats),
          client
            .get<WebsiteStats>(`/websites/${websiteId}/stats`, {
              startAt: resolved.startAt,
              endAt: resolved.endAt,
              ...goalFilters,
            })
            .then(normalizeStats),
        ]);

        const conversionPct = baseline.visitors
          ? Number(((goal.visitors / baseline.visitors) * 100).toFixed(1))
          : 0;

        const output = {
          website_id: websiteId,
          goal: { type: path ? ("path" as const) : ("event" as const), value: path ?? event ?? "" },
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          baseline_visitors: baseline.visitors,
          goal_visitors: goal.visitors,
          conversion_rate_pct: conversionPct,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        return textResult(
          `# ${label}: goal "${output.goal.value}" (${output.goal.type})\n\n` +
            `**Range**: ${output.range.start} to ${output.range.end}\n\n` +
            `- Baseline visitors: ${formatNumber(baseline.visitors)}\n` +
            `- Reached goal: ${formatNumber(goal.visitors)}\n` +
            `- Conversion rate: ${conversionPct}%`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
