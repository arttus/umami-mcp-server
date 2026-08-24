import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { resolveRange } from "../services/dates.js";
import {
  ResponseFormat,
  deriveStats,
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
  limitField,
  metricTypeField,
  offsetField,
  rangeField,
  responseFormatField,
  startDateField,
  websiteField,
} from "../schemas.js";
import type { ExpandedMetricRow, MetricRow } from "../types.js";

export function registerMetricsTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_get_metrics",
    {
      title: "Get ranked traffic breakdown",
      description: `Get a ranked breakdown of traffic by one dimension: top pages, referrers, countries, browsers, devices, acquisition channels, custom events, and more.

This is the workhorse for "top N" questions. Set expanded=true when you need engagement quality per row (pageviews, visitors, visits, bounces, time on site) rather than just a visitor count, for example to find which landing page bounces hardest.

Args:
  - website (string, optional): Website ID, name, or domain.
  - type (string, required): Dimension to break down by. 'path' (pages), 'entry' (landing pages), 'exit', 'referrer', 'channel', 'domain', 'country', 'region', 'city', 'browser', 'os', 'device', 'language', 'screen', 'title', 'query', 'event', 'hostname', 'tag', 'distinctId'.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - expanded (boolean): Return per-row engagement metrics instead of a single count (default: false).
  - limit (number): Rows to return, 1-500 (default: 20).
  - offset (number): Rows to skip for pagination (default: 0).
  - filters (object, optional): Segment filters, for example { country: 'US' } to see top pages among US visitors.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  Plain JSON shape: { "type": string, "count": number, "rows": [ { "name": string, "visitors": number, "share_pct": number } ], "has_more": boolean, "next_offset": number }
  Expanded JSON shape: { "type": string, "count": number, "rows": [ { "name": string, "pageviews": number, "visitors": number, "visits": number, "bounces": number, "bounce_rate_pct": number, "avg_visit_duration_seconds": number } ], ... }

Examples:
  - "What are our top 10 pages this month?" -> type="path", range="this_month", limit=10
  - "Where is traffic coming from?" -> type="referrer", range="30d"
  - "Which landing page has the worst bounce rate?" -> type="entry", expanded=true
  - "Top pages for mobile visitors in Florida" -> type="path", filters={ device: "mobile", region: "US-FL" }

Error handling:
  - Returns "No data" when the dimension has no rows in the range, which is expected for 'event' when no custom events are tracked.`,
      inputSchema: {
        website: websiteField,
        type: metricTypeField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        expanded: z
          .boolean()
          .default(false)
          .describe("Return per-row engagement metrics (pageviews, visits, bounces, time) instead of a single count."),
        limit: limitField,
        offset: offsetField,
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
    async ({
      website,
      type,
      range,
      start_date,
      end_date,
      expanded,
      limit,
      offset,
      filters,
      response_format,
    }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({
          range,
          start_date,
          end_date,
          timezone: client.timezone,
        });
        const path = expanded
          ? `/websites/${websiteId}/metrics/expanded`
          : `/websites/${websiteId}/metrics`;

        const raw = await client.get<MetricRow[] | ExpandedMetricRow[]>(path, {
          startAt: resolved.startAt,
          endAt: resolved.endAt,
          type,
          limit,
          offset,
          ...filtersToParams(filters),
        });

        const rowsRaw = Array.isArray(raw) ? raw : [];
        if (rowsRaw.length === 0) {
          return textResult(
            `No '${type}' data for ${new Date(resolved.startAt).toISOString()} to ${new Date(
              resolved.endAt
            ).toISOString()}.` +
              (type === "event"
                ? " Custom events only appear once the tracker fires umami.track('event-name')."
                : " Try a wider range, or check umami_get_website for the available data range.")
          );
        }

        const label = await getWebsiteLabel(client, websiteId);
        const hasMore = rowsRaw.length === limit;

        if (expanded) {
          const rows = (rowsRaw as ExpandedMetricRow[]).map((row) => {
            const derived = deriveStats({
              pageviews: row.pageviews ?? 0,
              visitors: row.visitors ?? 0,
              visits: row.visits ?? 0,
              bounces: row.bounces ?? 0,
              totaltime: row.totaltime ?? 0,
            });
            return {
              name: row.name ?? "(none)",
              pageviews: row.pageviews ?? 0,
              visitors: row.visitors ?? 0,
              visits: row.visits ?? 0,
              bounces: row.bounces ?? 0,
              bounce_rate_pct: derived.bounce_rate_pct,
              avg_visit_duration_seconds: derived.avg_visit_duration_seconds,
              avg_visit_duration_human: derived.avg_visit_duration_human,
            };
          });

          const output = {
            website_id: websiteId,
            type,
            expanded: true,
            range: {
              start: new Date(resolved.startAt).toISOString(),
              end: new Date(resolved.endAt).toISOString(),
            },
            count: rows.length,
            offset,
            rows,
            has_more: hasMore,
            ...(hasMore ? { next_offset: offset + rows.length } : {}),
          };

          if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

          const table = markdownTable(
            ["Value", "Visitors", "Pageviews", "Visits", "Bounce rate", "Avg visit"],
            rows.map((row) => [
              row.name,
              formatNumber(row.visitors),
              formatNumber(row.pageviews),
              formatNumber(row.visits),
              `${row.bounce_rate_pct}%`,
              row.avg_visit_duration_human,
            ])
          );
          return textResult(
            `# ${label}: ${type} breakdown (expanded)\n\n**Range**: ${output.range.start} to ${output.range.end}\n\n${table}` +
              (hasMore ? `\n\n_More rows available. Call again with offset=${offset + rows.length}._` : "")
          );
        }

        const plain = rowsRaw as MetricRow[];
        const total = plain.reduce((sum, row) => sum + (row.y ?? 0), 0);
        const rows = plain.map((row) => ({
          name: row.x ?? "(none)",
          visitors: row.y ?? 0,
          share_pct: total ? Number((((row.y ?? 0) / total) * 100).toFixed(1)) : 0,
        }));

        const output = {
          website_id: websiteId,
          type,
          expanded: false,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          count: rows.length,
          offset,
          total_in_page: total,
          rows,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + rows.length } : {}),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const table = markdownTable(
          ["Value", "Visitors", "Share of shown"],
          rows.map((row) => [row.name, formatNumber(row.visitors), `${row.share_pct}%`])
        );
        return textResult(
          `# ${label}: top ${type}\n\n**Range**: ${output.range.start} to ${output.range.end}\n\n${table}` +
            (hasMore ? `\n\n_More rows available. Call again with offset=${offset + rows.length}._` : "")
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
