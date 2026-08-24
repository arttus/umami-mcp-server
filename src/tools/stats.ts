import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { resolveWebsiteId, getWebsiteLabel } from "../services/websites.js";
import { resolveRange, suggestUnit } from "../services/dates.js";
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
  timezoneField,
  unitField,
  websiteField,
} from "../schemas.js";
import type { EventSeriesPoint, PageviewSeries, WebsiteStats } from "../types.js";

const EMPTY_STATS: WebsiteStats = {
  pageviews: 0,
  visitors: 0,
  visits: 0,
  bounces: 0,
  totaltime: 0,
};

export function normalizeStats(raw: unknown): WebsiteStats {
  const value = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): number => {
    const entry = value[key];
    if (typeof entry === "number") return entry;
    // Some Umami endpoints wrap values as { value: number }.
    if (entry && typeof entry === "object" && "value" in entry) {
      const inner = (entry as { value: unknown }).value;
      if (typeof inner === "number") return inner;
    }
    return 0;
  };
  return {
    pageviews: read("pageviews"),
    visitors: read("visitors"),
    visits: read("visits"),
    bounces: read("bounces"),
    totaltime: read("totaltime"),
  };
}

export function registerStatsTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_get_stats",
    {
      title: "Get website traffic stats",
      description: `Get summary traffic statistics for a website over a date range, with optional comparison to the immediately preceding period.

This is the headline-numbers tool: pageviews, visitors, visits, bounce rate, and average visit duration. Bounce rate and average visit duration are derived here, since Umami returns raw bounce and total-time counts.

Args:
  - website (string, optional): Website ID, name, or domain.
  - range (string): Date range, default '7d'. Relative ('24h', '7d', '30d'), named ('today', 'yesterday', 'last_week', 'last_month', 'mtd', 'ytd'), or use start_date/end_date.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - compare (boolean): Also return the previous period of equal length with percent change (default: true).
  - filters (object, optional): Segment filters such as { country: 'US', path: '/pricing' }.
  - timezone (string, optional): IANA timezone for day boundaries.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: {
    "website_id": string, "range": { "start": string, "end": string },
    "stats": { "pageviews": number, "visitors": number, "visits": number, "bounces": number, "totaltime": number,
               "bounce_rate_pct": number, "views_per_visit": number, "avg_visit_duration_seconds": number },
    "previous": { ...same fields... } | null,
    "change": { "pageviews": string, "visitors": string, "visits": string, "bounce_rate_pct": string } | null
  }

Examples:
  - "How did the site do last month?" -> range="last_month"
  - "Traffic from mobile users in the US this week" -> range="this_week", filters={ device: "mobile", country: "US" }
  - "Compare this month to last" -> range="mtd", compare=true

Error handling:
  - Returns a 404 error if the website ID does not exist.
  - All-zero results usually mean the range predates tracking; check umami_get_website for the available data range.`,
      inputSchema: {
        website: websiteField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        compare: z
          .boolean()
          .default(true)
          .describe("Include the previous period of equal length with percent change."),
        filters: filtersField,
        timezone: timezoneField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, range, start_date, end_date, compare, filters, timezone, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({
          range,
          start_date,
          end_date,
          timezone: timezone ?? client.timezone,
        });
        const filterParams = filtersToParams(filters);

        const current = normalizeStats(
          await client.get<WebsiteStats>(`/websites/${websiteId}/stats`, {
            startAt: resolved.startAt,
            endAt: resolved.endAt,
            ...filterParams,
          })
        );

        let previous: WebsiteStats | undefined;
        if (compare) {
          previous = normalizeStats(
            await client
              .get<WebsiteStats>(`/websites/${websiteId}/stats`, {
                startAt: resolved.previous.startAt,
                endAt: resolved.previous.endAt,
                ...filterParams,
              })
              .catch(() => EMPTY_STATS)
          );
        }

        const derivedCurrent = deriveStats(current);
        const derivedPrevious = previous ? deriveStats(previous) : undefined;

        const output = {
          website_id: websiteId,
          range: {
            label: resolved.label,
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          filters: Object.keys(filterParams).length ? filterParams : null,
          stats: { ...current, ...derivedCurrent },
          previous:
            previous && derivedPrevious
              ? {
                  start: new Date(resolved.previous.startAt).toISOString(),
                  end: new Date(resolved.previous.endAt).toISOString(),
                  ...previous,
                  ...derivedPrevious,
                }
              : null,
          change:
            previous && derivedPrevious
              ? {
                  pageviews: percentChange(current.pageviews, previous.pageviews),
                  visitors: percentChange(current.visitors, previous.visitors),
                  visits: percentChange(current.visits, previous.visits),
                  bounce_rate_pct: percentChange(
                    derivedCurrent.bounce_rate_pct,
                    derivedPrevious.bounce_rate_pct
                  ),
                }
              : null,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const rows: Array<Array<string | number>> = [
          ["Pageviews", formatNumber(current.pageviews)],
          ["Visitors", formatNumber(current.visitors)],
          ["Visits", formatNumber(current.visits)],
          ["Bounce rate", `${derivedCurrent.bounce_rate_pct}%`],
          ["Views per visit", derivedCurrent.views_per_visit],
          ["Avg visit duration", derivedCurrent.avg_visit_duration_human],
        ];

        let table: string;
        if (previous && derivedPrevious && output.change) {
          const previousValues = [
            formatNumber(previous.pageviews),
            formatNumber(previous.visitors),
            formatNumber(previous.visits),
            `${derivedPrevious.bounce_rate_pct}%`,
            derivedPrevious.views_per_visit,
            derivedPrevious.avg_visit_duration_human,
          ];
          const changes = [
            output.change.pageviews,
            output.change.visitors,
            output.change.visits,
            output.change.bounce_rate_pct,
            percentChange(derivedCurrent.views_per_visit, derivedPrevious.views_per_visit),
            percentChange(
              derivedCurrent.avg_visit_duration_seconds,
              derivedPrevious.avg_visit_duration_seconds
            ),
          ];
          table = markdownTable(
            ["Metric", "Current", "Previous", "Change"],
            rows.map((row, index) => [row[0], row[1], previousValues[index], changes[index]])
          );
        } else {
          table = markdownTable(["Metric", "Value"], rows);
        }

        const filterNote = Object.keys(filterParams).length
          ? `\n\nFilters applied: ${Object.entries(filterParams)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ")}`
          : "";

        return textResult(
          `# ${label}\n\n**Range**: ${output.range.start} to ${output.range.end} (${resolved.label})\n\n${table}${filterNote}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_pageviews_series",
    {
      title: "Get pageview time series",
      description: `Get pageviews and sessions bucketed over time, for trend and seasonality questions.

Use this when the question is about shape over time rather than a single total: which day spiked, whether traffic is trending up, what the weekday pattern looks like.

Args:
  - website (string, optional): Website ID, name, or domain.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - unit ('minute' | 'hour' | 'day' | 'month' | 'year', optional): Bucket size. Chosen automatically if omitted. Umami caps minute at 60 minutes, hour at 30 days, day at 6 months.
  - filters (object, optional): Segment filters.
  - timezone (string, optional): IANA timezone for bucket boundaries.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "website_id": string, "unit": string, "points": [ { "timestamp": string, "pageviews": number, "sessions": number } ], "totals": { "pageviews": number, "sessions": number }, "peak": { "timestamp": string, "pageviews": number } }

Examples:
  - "Show daily traffic for the last 30 days" -> range="30d", unit="day"
  - "What hour of the day is busiest?" -> range="24h", unit="hour"`,
      inputSchema: {
        website: websiteField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        unit: unitField,
        filters: filtersField,
        timezone: timezoneField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, range, start_date, end_date, unit, filters, timezone, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const tz = timezone ?? client.timezone;
        const resolved = resolveRange({ range, start_date, end_date, timezone: tz });
        const bucket = unit ?? suggestUnit(resolved.startAt, resolved.endAt);

        const series = await client.get<PageviewSeries>(`/websites/${websiteId}/pageviews`, {
          startAt: resolved.startAt,
          endAt: resolved.endAt,
          unit: bucket,
          timezone: tz,
          ...filtersToParams(filters),
        });

        const pageviews = series?.pageviews ?? [];
        const sessions = series?.sessions ?? [];
        const sessionByTime = new Map(sessions.map((point) => [point.x, point.y]));

        if (pageviews.length === 0) {
          return textResult(
            `No pageview data for this range (${new Date(resolved.startAt).toISOString()} to ${new Date(
              resolved.endAt
            ).toISOString()}). Check umami_get_website for the range of data actually collected.`
          );
        }

        const points = pageviews.map((point) => ({
          timestamp: point.x,
          pageviews: point.y,
          sessions: sessionByTime.get(point.x) ?? 0,
        }));

        const peak = points.reduce((best, point) =>
          point.pageviews > best.pageviews ? point : best
        );

        const output = {
          website_id: websiteId,
          unit: bucket,
          timezone: tz,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          points,
          totals: {
            pageviews: points.reduce((sum, point) => sum + point.pageviews, 0),
            sessions: points.reduce((sum, point) => sum + point.sessions, 0),
          },
          peak: { timestamp: peak.timestamp, pageviews: peak.pageviews },
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const table = markdownTable(
          ["Bucket", "Pageviews", "Sessions"],
          points.map((point) => [
            point.timestamp,
            formatNumber(point.pageviews),
            formatNumber(point.sessions),
          ])
        );
        return textResult(
          `# ${label}: pageviews by ${bucket}\n\n` +
            `**Range**: ${output.range.start} to ${output.range.end} (${tz})\n` +
            `**Totals**: ${formatNumber(output.totals.pageviews)} pageviews, ${formatNumber(
              output.totals.sessions
            )} sessions\n` +
            `**Peak bucket**: ${peak.timestamp} with ${formatNumber(peak.pageviews)} pageviews\n\n${table}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_events_series",
    {
      title: "Get custom events over time",
      description: `Get counts of custom tracked events bucketed over time, grouped by event name.

Use this for conversion and interaction tracking: form submits, button clicks, signups, or any event fired through umami.track().

Args:
  - website (string, optional): Website ID, name, or domain.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - unit ('minute' | 'hour' | 'day' | 'month' | 'year', optional): Bucket size, chosen automatically if omitted.
  - event (string, optional): Restrict to a single event name.
  - filters (object, optional): Segment filters.
  - timezone (string, optional): IANA timezone.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "website_id": string, "unit": string, "totals_by_event": { "<event name>": number }, "series": [ { "event": string, "timestamp": string, "count": number } ] }

Examples:
  - "How many contact form submits last week?" -> range="last_week", event="contact-form-submit"
  - "Which events fire most often?" -> range="30d"`,
      inputSchema: {
        website: websiteField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        unit: unitField,
        event: z.string().optional().describe("Restrict results to a single event name."),
        filters: filtersField,
        timezone: timezoneField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, range, start_date, end_date, unit, event, filters, timezone, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const tz = timezone ?? client.timezone;
        const resolved = resolveRange({ range, start_date, end_date, timezone: tz });
        const bucket = unit ?? suggestUnit(resolved.startAt, resolved.endAt);

        const raw = await client.get<EventSeriesPoint[]>(`/websites/${websiteId}/events/series`, {
          startAt: resolved.startAt,
          endAt: resolved.endAt,
          unit: bucket,
          timezone: tz,
          ...filtersToParams(filters),
          ...(event ? { event } : {}),
        });

        const points = Array.isArray(raw) ? raw : [];
        if (points.length === 0) {
          return textResult(
            `No custom events recorded in this range. Custom events must be fired from the tracker with umami.track('event-name').`
          );
        }

        const totals: Record<string, number> = {};
        for (const point of points) {
          totals[point.x] = (totals[point.x] ?? 0) + point.y;
        }

        const output = {
          website_id: websiteId,
          unit: bucket,
          timezone: tz,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          totals_by_event: totals,
          series: points.map((point) => ({
            event: point.x,
            timestamp: point.t,
            count: point.y,
          })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
        const table = markdownTable(
          ["Event", "Total"],
          ranked.map(([name, count]) => [name || "(unnamed)", formatNumber(count)])
        );
        const label = await getWebsiteLabel(client, websiteId);
        return textResult(
          `# ${label}: custom events\n\n**Range**: ${output.range.start} to ${output.range.end}\n**Bucket**: ${bucket}\n\n${table}\n\n_Call again with response_format='json' for the full per-bucket series._`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
