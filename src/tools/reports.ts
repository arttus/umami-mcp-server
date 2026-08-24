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
  percentChange,
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
import { METRIC_TYPES, type MetricType } from "../constants.js";
import type { MetricRow, WebsiteStats } from "../types.js";

const DEFAULT_BREAKDOWNS: MetricType[] = [
  "path",
  "entry",
  "referrer",
  "channel",
  "country",
  "device",
  "browser",
];

const EMPTY: WebsiteStats = { pageviews: 0, visitors: 0, visits: 0, bounces: 0, totaltime: 0 };

export function registerReportTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_traffic_report",
    {
      title: "Full traffic report",
      description: `Build a complete traffic report for a website in one call: headline stats, period-over-period change, and ranked breakdowns for top pages, landing pages, referrers, acquisition channels, countries, devices, and browsers.

Prefer this over chaining umami_get_stats and several umami_get_metrics calls when the question is broad, for example "how is the site doing" or "give me last month's analytics". Use the individual tools instead when you need one specific dimension, deeper pagination, or expanded engagement metrics.

Args:
  - website (string, optional): Website ID, name, or domain.
  - range (string): Date range, default '30d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - breakdowns (array of strings, optional): Which dimensions to include. Defaults to path, entry, referrer, channel, country, device, browser.
  - limit (number): Rows per breakdown, 1-50 (default: 10).
  - compare (boolean): Include the previous period of equal length with percent change (default: true).
  - filters (object, optional): Segment filters applied to every part of the report.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: {
    "website": string, "range": { "start": string, "end": string },
    "stats": { "pageviews": number, "visitors": number, "visits": number, "bounce_rate_pct": number, "avg_visit_duration_seconds": number },
    "change": { "pageviews": string, "visitors": string, "visits": string } | null,
    "breakdowns": { "<dimension>": [ { "name": string, "visitors": number, "share_pct": number } ] }
  }

Examples:
  - "Give me the analytics rundown for last month" -> range="last_month"
  - "How did the site do this week versus last?" -> range="this_week", compare=true
  - "Full report for US mobile traffic" -> filters={ country: "US", device: "mobile" }

Error handling:
  - Individual breakdowns that fail are omitted rather than failing the whole report; the response notes which ones were skipped.`,
      inputSchema: {
        website: websiteField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        breakdowns: z
          .array(z.enum(METRIC_TYPES))
          .optional()
          .describe(
            "Dimensions to include. Defaults to path, entry, referrer, channel, country, device, browser."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Rows per breakdown."),
        compare: z
          .boolean()
          .default(true)
          .describe("Include the previous period of equal length with percent change."),
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
      range,
      start_date,
      end_date,
      breakdowns,
      limit,
      compare,
      filters,
      response_format,
    }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const label = await getWebsiteLabel(client, websiteId);
        const resolved = resolveRange({
          range: range ?? "30d",
          start_date,
          end_date,
          timezone: client.timezone,
        });
        const filterParams = filtersToParams(filters);
        const dimensions = breakdowns?.length ? breakdowns : DEFAULT_BREAKDOWNS;

        const statsPromise = client.get<WebsiteStats>(`/websites/${websiteId}/stats`, {
          startAt: resolved.startAt,
          endAt: resolved.endAt,
          ...filterParams,
        });

        const previousPromise = compare
          ? client
              .get<WebsiteStats>(`/websites/${websiteId}/stats`, {
                startAt: resolved.previous.startAt,
                endAt: resolved.previous.endAt,
                ...filterParams,
              })
              .catch(() => EMPTY)
          : Promise.resolve(undefined);

        const breakdownPromises = dimensions.map(async (type) => {
          try {
            const rows = await client.get<MetricRow[]>(`/websites/${websiteId}/metrics`, {
              startAt: resolved.startAt,
              endAt: resolved.endAt,
              type,
              limit,
              ...filterParams,
            });
            return { type, rows: Array.isArray(rows) ? rows : [], failed: false };
          } catch {
            return { type, rows: [] as MetricRow[], failed: true };
          }
        });

        const [statsRaw, previousRaw, breakdownResults] = await Promise.all([
          statsPromise,
          previousPromise,
          Promise.all(breakdownPromises),
        ]);

        const stats = { ...EMPTY, ...(statsRaw ?? {}) };
        const derived = deriveStats(stats);
        const previous = previousRaw ? { ...EMPTY, ...previousRaw } : undefined;
        const derivedPrevious = previous ? deriveStats(previous) : undefined;

        const breakdownOutput: Record<
          string,
          Array<{ name: string; visitors: number; share_pct: number }>
        > = {};
        const skipped: string[] = [];

        for (const result of breakdownResults) {
          if (result.failed) {
            skipped.push(result.type);
            continue;
          }
          const total = result.rows.reduce((sum, row) => sum + (row.y ?? 0), 0);
          breakdownOutput[result.type] = result.rows.map((row) => ({
            name: row.x ?? "(none)",
            visitors: row.y ?? 0,
            share_pct: total ? Number((((row.y ?? 0) / total) * 100).toFixed(1)) : 0,
          }));
        }

        const output = {
          website: label,
          website_id: websiteId,
          range: {
            label: resolved.label,
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          filters: Object.keys(filterParams).length ? filterParams : null,
          stats: { ...stats, ...derived },
          previous:
            previous && derivedPrevious ? { ...previous, ...derivedPrevious } : null,
          change:
            previous && derivedPrevious
              ? {
                  pageviews: percentChange(stats.pageviews, previous.pageviews),
                  visitors: percentChange(stats.visitors, previous.visitors),
                  visits: percentChange(stats.visits, previous.visits),
                  bounce_rate_pct: percentChange(
                    derived.bounce_rate_pct,
                    derivedPrevious.bounce_rate_pct
                  ),
                }
              : null,
          breakdowns: breakdownOutput,
          ...(skipped.length ? { skipped_breakdowns: skipped } : {}),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const sections: string[] = [
          `# Traffic report: ${label}`,
          "",
          `**Range**: ${output.range.start} to ${output.range.end} (${resolved.label})`,
        ];

        if (Object.keys(filterParams).length) {
          sections.push(
            `**Filters**: ${Object.entries(filterParams)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ")}`
          );
        }

        sections.push("", "## Summary", "");
        if (previous && derivedPrevious && output.change) {
          sections.push(
            markdownTable(
              ["Metric", "Current", "Previous", "Change"],
              [
                ["Pageviews", formatNumber(stats.pageviews), formatNumber(previous.pageviews), output.change.pageviews],
                ["Visitors", formatNumber(stats.visitors), formatNumber(previous.visitors), output.change.visitors],
                ["Visits", formatNumber(stats.visits), formatNumber(previous.visits), output.change.visits],
                [
                  "Bounce rate",
                  `${derived.bounce_rate_pct}%`,
                  `${derivedPrevious.bounce_rate_pct}%`,
                  output.change.bounce_rate_pct,
                ],
                [
                  "Avg visit",
                  derived.avg_visit_duration_human,
                  derivedPrevious.avg_visit_duration_human,
                  percentChange(
                    derived.avg_visit_duration_seconds,
                    derivedPrevious.avg_visit_duration_seconds
                  ),
                ],
              ]
            )
          );
        } else {
          sections.push(
            markdownTable(
              ["Metric", "Value"],
              [
                ["Pageviews", formatNumber(stats.pageviews)],
                ["Visitors", formatNumber(stats.visitors)],
                ["Visits", formatNumber(stats.visits)],
                ["Bounce rate", `${derived.bounce_rate_pct}%`],
                ["Avg visit", derived.avg_visit_duration_human],
              ]
            )
          );
        }

        const headings: Partial<Record<MetricType, string>> = {
          path: "Top pages",
          entry: "Top landing pages",
          exit: "Top exit pages",
          referrer: "Top referrers",
          channel: "Acquisition channels",
          country: "Countries",
          device: "Devices",
          browser: "Browsers",
          os: "Operating systems",
          city: "Cities",
          region: "Regions",
          event: "Custom events",
        };

        for (const type of dimensions) {
          const rows = breakdownOutput[type];
          if (!rows) continue;
          sections.push("", `## ${headings[type] ?? type}`, "");
          sections.push(
            rows.length
              ? markdownTable(
                  ["Value", "Visitors", "Share"],
                  rows.map((row) => [row.name, formatNumber(row.visitors), `${row.share_pct}%`])
                )
              : "_No data._"
          );
        }

        if (skipped.length) {
          sections.push("", `_Breakdowns unavailable on this Umami version: ${skipped.join(", ")}._`);
        }

        return textResult(sections.join("\n"));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
