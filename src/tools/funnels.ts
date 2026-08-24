import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { resolveRange } from "../services/dates.js";
import { collectSessionJourneys } from "../services/journeys.js";
import {
  ResponseFormat,
  errorResult,
  formatNumber,
  markdownTable,
  textResult,
  toJson,
} from "../format.js";
import {
  endDateField,
  filtersField,
  filtersToParams,
  rangeField,
  responseFormatField,
  startDateField,
  websiteField,
} from "../schemas.js";

const maxSessionsField = z
  .number()
  .int()
  .min(10)
  .max(2000)
  .default(500)
  .describe("Maximum sessions to scan. Higher is more accurate but slower (one extra API call per session).");

export function registerFunnelTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_get_funnel",
    {
      title: "Get funnel conversion across ordered steps",
      description: `Get session counts and drop-off across an ordered sequence of pages and/or custom events.

Umami has no funnel endpoint, so this walks every session's activity trail in the range (capped by max_sessions) looking for the steps in order. A step matches a page path or a custom event name, whichever it equals; a session only advances once it has completed the previous step.

Args:
  - website (string, optional): Website ID, name, or domain.
  - steps (string[], required): 2-8 steps in order, each a page path (e.g. '/pricing') or event name (e.g. 'signup').
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - filters (object, optional): Segment filters applied to the session pool, e.g. { device: 'mobile' }.
  - max_sessions (number): Cap on sessions scanned, default 500, max 2000.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "steps": [ { "step": string, "sessions": number, "pct_of_first": number, "pct_of_previous": number } ], "scanned_sessions": number, "total_sessions_in_range": number, "truncated": boolean }

Examples:
  - "Funnel from pricing to signup to activation" -> steps=["/pricing", "/signup", "activation"]

Error handling:
  - If 'truncated' is true, total sessions in the range exceeded max_sessions; raise it for a more complete picture, at the cost of more API calls.`,
      inputSchema: {
        website: websiteField,
        steps: z
          .array(z.string().min(1))
          .min(2)
          .max(8)
          .describe("Ordered steps: page paths or event names."),
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        filters: filtersField,
        max_sessions: maxSessionsField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, steps, range, start_date, end_date, filters, max_sessions, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({ range, start_date, end_date, timezone: client.timezone });

        const { journeys, totalSessions, scanned } = await collectSessionJourneys(
          client,
          websiteId,
          resolved,
          { maxSessions: max_sessions, filters: filtersToParams(filters) }
        );

        const counts = new Array(steps.length).fill(0);
        for (const journey of journeys) {
          let stepIndex = 0;
          let cursor = -Infinity;
          for (const touch of journey.touches) {
            if (stepIndex >= steps.length) break;
            if (touch.value === steps[stepIndex] && touch.at >= cursor) {
              counts[stepIndex] += 1;
              cursor = touch.at;
              stepIndex += 1;
            }
          }
        }

        const rows = steps.map((step, i) => ({
          step,
          sessions: counts[i],
          pct_of_first: counts[0] ? Number(((counts[i] / counts[0]) * 100).toFixed(1)) : 0,
          pct_of_previous:
            i === 0 ? 100 : counts[i - 1] ? Number(((counts[i] / counts[i - 1]) * 100).toFixed(1)) : 0,
        }));

        const output = {
          website_id: websiteId,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          steps: rows,
          scanned_sessions: scanned,
          total_sessions_in_range: totalSessions,
          truncated: scanned < totalSessions,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const table = markdownTable(
          ["Step", "Sessions", "% of step 1", "% of previous"],
          rows.map((r) => [r.step, formatNumber(r.sessions), `${r.pct_of_first}%`, `${r.pct_of_previous}%`])
        );
        return textResult(
          `# ${label}: funnel\n\n**Range**: ${output.range.start} to ${output.range.end}\n` +
            `**Scanned**: ${formatNumber(scanned)} of ${formatNumber(totalSessions)} sessions\n\n${table}` +
            (output.truncated
              ? `\n\n_Only scanned ${formatNumber(scanned)} of ${formatNumber(totalSessions)} sessions. Raise max_sessions for full coverage._`
              : "")
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_journeys",
    {
      title: "Get common page-visit sequences",
      description: `Get the most common sequences of pages visitors take through the site.

Umami has no journey/path-analysis endpoint, so this walks every session's activity trail in the range (capped by max_sessions), reduces each to its ordered page paths (consecutive repeats collapsed), truncates to 'depth' steps, and ranks the most frequent sequences.

Args:
  - website (string, optional): Website ID, name, or domain.
  - start_path (string, optional): Only include sessions whose first page matches this path, e.g. '/'.
  - depth (number): Steps per sequence shown, default 4, max 8.
  - limit (number): Top N sequences to return, default 10, max 50.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - filters (object, optional): Segment filters applied to the session pool.
  - max_sessions (number): Cap on sessions scanned, default 500, max 2000.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "sequences": [ { "path": string, "sessions": number, "pct": number } ], "matched_sessions": number, "scanned_sessions": number, "total_sessions_in_range": number, "truncated": boolean }

Examples:
  - "What do people do after landing on the homepage?" -> start_path="/", depth=3`,
      inputSchema: {
        website: websiteField,
        start_path: z.string().optional().describe("Only include sessions whose first page matches this path."),
        depth: z.number().int().min(2).max(8).default(4).describe("Steps per sequence shown."),
        limit: z.number().int().min(1).max(50).default(10).describe("Top N sequences to return."),
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        filters: filtersField,
        max_sessions: maxSessionsField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      website,
      start_path,
      depth,
      limit,
      range,
      start_date,
      end_date,
      filters,
      max_sessions,
      response_format,
    }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({ range, start_date, end_date, timezone: client.timezone });

        const { journeys, totalSessions, scanned } = await collectSessionJourneys(
          client,
          websiteId,
          resolved,
          { maxSessions: max_sessions, filters: filtersToParams(filters) }
        );

        const sequenceCounts = new Map<string, number>();
        let matched = 0;

        for (const journey of journeys) {
          const pages: string[] = [];
          for (const touch of journey.touches) {
            if (touch.kind !== "page") continue;
            if (pages[pages.length - 1] !== touch.value) pages.push(touch.value);
          }
          if (pages.length === 0) continue;
          if (start_path && pages[0] !== start_path) continue;
          matched += 1;
          const key = pages.slice(0, depth).join(" → ");
          sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1);
        }

        const sequences = [...sequenceCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([path, count]) => ({
            path,
            sessions: count,
            pct: matched ? Number(((count / matched) * 100).toFixed(1)) : 0,
          }));

        const output = {
          website_id: websiteId,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          sequences,
          matched_sessions: matched,
          scanned_sessions: scanned,
          total_sessions_in_range: totalSessions,
          truncated: scanned < totalSessions,
        };

        if (sequences.length === 0) {
          return textResult(
            `No page sequences found${start_path ? ` starting at '${start_path}'` : ""} for ${output.range.start} to ${output.range.end}.`
          );
        }

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const table = markdownTable(
          ["Sequence", "Sessions", "% of matched"],
          sequences.map((s) => [s.path, formatNumber(s.sessions), `${s.pct}%`])
        );
        return textResult(
          `# ${label}: journeys\n\n**Range**: ${output.range.start} to ${output.range.end}\n` +
            `**Matched sessions**: ${formatNumber(matched)} (scanned ${formatNumber(scanned)} of ${formatNumber(totalSessions)})\n\n${table}` +
            (output.truncated
              ? `\n\n_Only scanned ${formatNumber(scanned)} of ${formatNumber(totalSessions)} sessions. Raise max_sessions for full coverage._`
              : "")
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
