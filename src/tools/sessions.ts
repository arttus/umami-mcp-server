import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { resolveRange } from "../services/dates.js";
import {
  ResponseFormat,
  errorResult,
  formatDuration,
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
import type { Paged, SessionActivity, SessionDetail, SessionSummary } from "../types.js";

export function registerSessionTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_list_sessions",
    {
      title: "List visitor sessions",
      description: `List individual visitor sessions for a website over a date range, newest first.

Sessions are anonymous. Use this to inspect real visit behaviour rather than aggregates: how many pages a typical visit covers, where high-engagement visitors come from, or what a spike actually consisted of.

Args:
  - website (string, optional): Website ID, name, or domain.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - search (string, optional): Free-text search across session attributes.
  - page (number): Page number, 1-based (default: 1).
  - page_size (number): Sessions per page, 1-100 (default: 20).
  - filters (object, optional): Segment filters such as { country: 'US' }.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "total": number, "page": number, "page_size": number, "sessions": [ { "id": string, "country": string, "city": string, "device": string, "browser": string, "os": string, "first_at": string, "last_at": string, "visits": number, "views": number } ], "has_more": boolean }

Examples:
  - "Show me sessions from yesterday" -> range="yesterday"
  - "Which visits looked at the most pages this week?" -> range="this_week", page_size=50

Error handling:
  - Returns an empty result set when no sessions occurred in the range.`,
      inputSchema: {
        website: websiteField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        search: z.string().optional().describe("Free-text search across session attributes."),
        page: z.number().int().min(1).default(1).describe("Page number, 1-based."),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Sessions per page."),
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
    async ({ website, range, start_date, end_date, search, page, page_size, filters, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({ range, start_date, end_date, timezone: client.timezone });

        const result = await client.get<Paged<SessionSummary>>(
          `/websites/${websiteId}/sessions`,
          {
            startAt: resolved.startAt,
            endAt: resolved.endAt,
            page,
            pageSize: page_size,
            ...(search ? { search } : {}),
            ...filtersToParams(filters),
          }
        );

        const sessions = result?.data ?? [];
        const total = result?.count ?? sessions.length;

        if (sessions.length === 0) {
          return textResult(
            `No sessions found for ${new Date(resolved.startAt).toISOString()} to ${new Date(
              resolved.endAt
            ).toISOString()}.`
          );
        }

        const output = {
          website_id: websiteId,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          total,
          page,
          page_size,
          sessions: sessions.map((session) => ({
            id: session.id,
            country: session.country ?? null,
            region: session.region ?? null,
            city: session.city ?? null,
            device: session.device ?? null,
            browser: session.browser ?? null,
            os: session.os ?? null,
            hostname: session.hostname ?? null,
            first_at: session.firstAt,
            last_at: session.lastAt,
            visits: session.visits,
            views: session.views,
          })),
          has_more: page * page_size < total,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const table = markdownTable(
          ["Session", "Location", "Device", "Views", "Visits", "Last seen"],
          output.sessions.map((session) => [
            session.id.slice(0, 8),
            [session.city, session.country].filter(Boolean).join(", ") || "unknown",
            [session.device, session.browser].filter(Boolean).join(" / ") || "unknown",
            session.views,
            session.visits,
            session.last_at,
          ])
        );
        return textResult(
          `# ${label}: sessions\n\n**Range**: ${output.range.start} to ${output.range.end}\n` +
            `**Total sessions**: ${formatNumber(total)} (page ${page} of ${Math.ceil(
              total / page_size
            )})\n\n${table}\n\n_Session IDs are shortened here. Use response_format='json' for full IDs to pass to umami_get_session._`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_session",
    {
      title: "Get session detail and activity",
      description: `Get details for one visitor session, optionally including the full page-by-page activity trail.

Use this to trace an individual journey through the site: entry page, path taken, events fired, exit point. Get session IDs from umami_list_sessions with response_format='json'.

Args:
  - website (string, optional): Website ID, name, or domain.
  - session_id (string, required): Session UUID.
  - include_activity (boolean): Include the chronological page and event trail (default: true).
  - range (string): Date range to search for activity, default '30d'. Activity outside this range is not returned.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "session": { "id": string, "country": string, "device": string, "browser": string, "os": string, "first_at": string, "last_at": string, "visits": number, "views": number, "events": number, "totaltime": number }, "activity": [ { "created_at": string, "url_path": string, "referrer_domain": string, "event_name": string } ] }

Examples:
  - "What did session abc123 do on the site?" -> session_id="abc123...", include_activity=true`,
      inputSchema: {
        website: websiteField,
        session_id: z.string().min(1).describe("Session UUID, from umami_list_sessions."),
        include_activity: z
          .boolean()
          .default(true)
          .describe("Include the chronological page and event trail."),
        range: z
          .string()
          .optional()
          .describe("Date range to search for activity, default '30d'."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, session_id, include_activity, range, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({ range: range ?? "30d", timezone: client.timezone });

        const session = await client.get<SessionDetail>(
          `/websites/${websiteId}/sessions/${session_id}`
        );

        let activity: SessionActivity[] = [];
        if (include_activity) {
          const raw = await client
            .get<SessionActivity[]>(`/websites/${websiteId}/sessions/${session_id}/activity`, {
              startAt: resolved.startAt,
              endAt: resolved.endAt,
            })
            .catch(() => []);
          activity = Array.isArray(raw) ? raw : [];
        }

        const output = {
          session: {
            id: session.id,
            country: session.country ?? null,
            region: session.region ?? null,
            city: session.city ?? null,
            device: session.device ?? null,
            browser: session.browser ?? null,
            os: session.os ?? null,
            screen: session.screen ?? null,
            language: session.language ?? null,
            first_at: session.firstAt,
            last_at: session.lastAt,
            visits: session.visits,
            views: session.views,
            events: session.events ?? 0,
            totaltime: session.totaltime ?? 0,
          },
          activity: activity.map((item) => ({
            created_at: item.createdAt,
            url_path: item.urlPath,
            url_query: item.urlQuery || null,
            referrer_domain: item.referrerDomain || null,
            event_name: item.eventName || null,
            event_type: item.eventType,
          })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const lines = [
          `# Session ${session.id}`,
          "",
          `- **Location**: ${[output.session.city, output.session.region, output.session.country]
            .filter(Boolean)
            .join(", ") || "unknown"}`,
          `- **Device**: ${[output.session.device, output.session.os, output.session.browser]
            .filter(Boolean)
            .join(" / ") || "unknown"}`,
          `- **First seen**: ${output.session.first_at}`,
          `- **Last seen**: ${output.session.last_at}`,
          `- **Visits**: ${output.session.visits}, **Pageviews**: ${output.session.views}, **Events**: ${output.session.events}`,
          `- **Time on site**: ${formatDuration(output.session.totaltime)}`,
        ];

        if (output.activity.length > 0) {
          lines.push(
            "",
            "## Activity trail",
            "",
            markdownTable(
              ["Time", "Path", "Referrer", "Event"],
              output.activity.map((item) => [
                item.created_at,
                item.url_path + (item.url_query ? `?${item.url_query}` : ""),
                item.referrer_domain ?? "",
                item.event_name ?? "",
              ])
            )
          );
        } else if (include_activity) {
          lines.push("", "_No activity found in the searched range. Widen 'range' if the session is older._");
        }

        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
