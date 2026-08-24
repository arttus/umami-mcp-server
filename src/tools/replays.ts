import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { resolveRange } from "../services/dates.js";
import { collectClicks, extractTimeline, getReplay, listReplays } from "../services/replays.js";
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
  rangeField,
  responseFormatField,
  startDateField,
  websiteField,
} from "../schemas.js";

export function registerReplayTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_list_replays",
    {
      title: "List session replay recordings",
      description: `List recorded session replays for a website over a date range, newest first.

Replays only exist where recording is enabled (umami_get_recorder_config) and a session was sampled. Use umami_get_replay to inspect one in detail.

Args:
  - website (string, optional): Website ID, name, or domain.
  - range (string): Date range, default '7d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - page (number): Page number, 1-based (default: 1).
  - page_size (number): Recordings per page, 1-100 (default: 20).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "total": number, "page": number, "page_size": number, "replays": [ { "id": string, "session_id": string, "device": string, "browser": string, "os": string, "country": string, "duration_seconds": number, "event_count": number, "started_at": string } ] }

Error handling:
  - An empty result usually means recording is off for this website, or no session was sampled in the range. Check umami_get_recorder_config.`,
      inputSchema: {
        website: websiteField,
        range: rangeField,
        start_date: startDateField,
        end_date: endDateField,
        page: z.number().int().min(1).default(1).describe("Page number, 1-based."),
        page_size: z.number().int().min(1).max(100).default(20).describe("Recordings per page."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, range, start_date, end_date, page, page_size, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({ range, start_date, end_date, timezone: client.timezone });

        const result = await listReplays(client, websiteId, resolved, { page, pageSize: page_size });
        const replays = result?.data ?? [];
        const total = result?.count ?? replays.length;

        if (replays.length === 0) {
          return textResult(
            `No replays found for ${new Date(resolved.startAt).toISOString()} to ${new Date(
              resolved.endAt
            ).toISOString()}. Check umami_get_recorder_config: recording may be off, or no session was sampled.`
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
          replays: replays.map((r) => ({
            id: r.id,
            session_id: r.sessionId,
            device: r.device ?? null,
            browser: r.browser ?? null,
            os: r.os ?? null,
            country: r.country ?? null,
            city: r.city ?? null,
            duration_seconds: Math.round((r.duration ?? 0) / 1000),
            event_count: r.eventCount,
            started_at: r.startedAt,
          })),
          has_more: page * page_size < total,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const table = markdownTable(
          ["Replay", "Location", "Device", "Duration", "Events", "Started"],
          output.replays.map((r) => [
            r.id.slice(0, 8),
            [r.city, r.country].filter(Boolean).join(", ") || "unknown",
            [r.device, r.browser].filter(Boolean).join(" / ") || "unknown",
            formatDuration(r.duration_seconds),
            r.event_count,
            r.started_at,
          ])
        );
        return textResult(
          `# ${label}: replays\n\n**Range**: ${output.range.start} to ${output.range.end}\n` +
            `**Total**: ${formatNumber(total)} (page ${page} of ${Math.ceil(total / page_size)})\n\n${table}\n\n` +
            `_Replay IDs are shortened here. Use response_format='json' for full IDs to pass to umami_get_replay._`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_replay",
    {
      title: "Get a session replay summary",
      description: `Summarize one recorded session replay: pages visited, click count, and a duration/event breakdown.

This does not return the raw rrweb event stream (it can be tens of thousands of events); it summarizes it. Get replay IDs from umami_list_replays with response_format='json'.

Args:
  - website (string, optional): Website ID, name, or domain.
  - replay_id (string, required): Replay UUID.
  - include_clicks (boolean): Include the raw click coordinates (default: false, capped at 200).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "session_id": string, "pages": [ { "href": string, "at": string } ], "click_count": number, "clicks": [ { "x": number, "y": number, "pathname": string } ] | undefined }`,
      inputSchema: {
        website: websiteField,
        replay_id: z.string().min(1).describe("Replay UUID, from umami_list_replays."),
        include_clicks: z
          .boolean()
          .default(false)
          .describe("Include raw click coordinates, capped at 200."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, replay_id, include_clicks, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const detail = await getReplay(client, websiteId, replay_id);
        const { pages, clicks } = extractTimeline(detail.events ?? []);

        const output = {
          website_id: websiteId,
          replay_id,
          session_id: detail.sessionId,
          event_count: detail.events?.length ?? 0,
          pages: pages.map((p) => ({ href: p.href, at: new Date(p.at).toISOString() })),
          click_count: clicks.length,
          ...(include_clicks
            ? {
                clicks: clicks.slice(0, 200).map((c) => ({
                  x: c.x,
                  y: c.y,
                  pathname: c.pathname,
                  at: new Date(c.at).toISOString(),
                })),
              }
            : {}),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        const lines = [
          `# ${label}: replay ${replay_id}`,
          "",
          `- **Session**: ${detail.sessionId}`,
          `- **Total rrweb events**: ${formatNumber(output.event_count)}`,
          `- **Clicks captured**: ${formatNumber(output.click_count)}`,
        ];
        if (pages.length > 0) {
          lines.push(
            "",
            "## Pages visited",
            "",
            markdownTable(
              ["Time", "URL"],
              output.pages.map((p) => [p.at, p.href])
            )
          );
        }
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_click_heatmap",
    {
      title: "Get a click heatmap for a page",
      description: `Get a click-density heatmap for one page path, built from recorded session replays.

Umami has no dedicated heatmap endpoint. Click coordinates are captured inside session replay recordings, so this filters replays to the given path, downloads them (capped by max_replays), extracts every click's (x, y) position, normalizes it against that recording's viewport size, and buckets it into a grid.

Args:
  - website (string, optional): Website ID, name, or domain.
  - path (string, required): Exact page path to build the heatmap for, e.g. '/pricing'.
  - range (string): Date range, default '30d' (replay volume is usually much lower than pageview volume).
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - grid_size (number): Buckets per axis, default 10 (a 10x10 grid), max 20.
  - max_replays (number): Cap on replays downloaded, default 100, max 300.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "path": string, "sample_replays": number, "replays_with_clicks": number, "total_clicks": number, "grid_size": number, "cells": [ { "row": number, "col": number, "x_pct_range": [number, number], "y_pct_range": [number, number], "clicks": number } ] }

Error handling:
  - Zero clicks usually means recording is off for this page's traffic, sampling missed it, or no one has clicked yet; check umami_list_replays for that path first.`,
      inputSchema: {
        website: websiteField,
        path: z.string().min(1).describe("Exact page path, e.g. '/pricing'."),
        range: z.string().optional().describe("Date range, default '30d'."),
        start_date: startDateField,
        end_date: endDateField,
        grid_size: z.number().int().min(4).max(20).default(10).describe("Buckets per axis."),
        max_replays: z.number().int().min(1).max(300).default(100).describe("Cap on replays downloaded."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, path, range, start_date, end_date, grid_size, max_replays, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({
          range: range ?? "30d",
          start_date,
          end_date,
          timezone: client.timezone,
        });

        const replayIds: string[] = [];
        let total = 0;
        let page = 1;
        const pageSize = 100;
        while (replayIds.length < max_replays) {
          const result = await listReplays(client, websiteId, resolved, { page, pageSize, path });
          const batch = result?.data ?? [];
          total = result?.count ?? batch.length;
          replayIds.push(...batch.map((r) => r.id));
          if (batch.length < pageSize || replayIds.length >= total) break;
          page += 1;
        }
        const capped = replayIds.slice(0, max_replays);

        if (capped.length === 0) {
          return textResult(
            `No replays found for path '${path}' in ${new Date(resolved.startAt).toISOString()} to ${new Date(
              resolved.endAt
            ).toISOString()}. Check umami_list_replays without a path filter to see what was recorded.`
          );
        }

        const { clicks, withDataCount } = await collectClicks(client, websiteId, capped);
        const matching = clicks.filter((c) => c.pathname === path);

        const cells = new Map<string, number>();
        for (const click of matching) {
          const xPct = Math.min(99.999, (click.x / click.viewportWidth) * 100);
          const yPct = Math.min(99.999, (click.y / click.viewportHeight) * 100);
          if (xPct < 0 || yPct < 0) continue;
          const col = Math.floor((xPct / 100) * grid_size);
          const row = Math.floor((yPct / 100) * grid_size);
          const key = `${row},${col}`;
          cells.set(key, (cells.get(key) ?? 0) + 1);
        }

        const cellRows = [...cells.entries()]
          .map(([key, count]) => {
            const [row, col] = key.split(",").map(Number);
            return {
              row,
              col,
              x_pct_range: [Number(((col / grid_size) * 100).toFixed(1)), Number((((col + 1) / grid_size) * 100).toFixed(1))] as [number, number],
              y_pct_range: [Number(((row / grid_size) * 100).toFixed(1)), Number((((row + 1) / grid_size) * 100).toFixed(1))] as [number, number],
              clicks: count,
            };
          })
          .sort((a, b) => b.clicks - a.clicks);

        const output = {
          website_id: websiteId,
          path,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          sample_replays: capped.length,
          replays_with_clicks: withDataCount,
          total_replays_matching_path: total,
          total_clicks: matching.length,
          grid_size,
          cells: cellRows,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        if (matching.length === 0) {
          return textResult(
            `# ${label}: click heatmap for ${path}\n\n**Range**: ${output.range.start} to ${output.range.end}\n\n` +
              `Sampled ${formatNumber(capped.length)} of ${formatNumber(total)} recordings for this path, but found no click events. ` +
              "Recordings may only contain scroll/mutation data if the tracker's click capture wasn't active for these sessions."
          );
        }

        const table = markdownTable(
          ["Row", "Col", "X range", "Y range", "Clicks"],
          cellRows.slice(0, 20).map((c) => [
            c.row,
            c.col,
            `${c.x_pct_range[0]}-${c.x_pct_range[1]}%`,
            `${c.y_pct_range[0]}-${c.y_pct_range[1]}%`,
            c.clicks,
          ])
        );
        return textResult(
          `# ${label}: click heatmap for ${path}\n\n**Range**: ${output.range.start} to ${output.range.end}\n` +
            `**Sampled**: ${formatNumber(capped.length)} of ${formatNumber(total)} matching recordings, ${formatNumber(
              matching.length
            )} clicks, ${grid_size}x${grid_size} grid\n\n${table}` +
            (cellRows.length > 20 ? `\n\n_Showing top 20 of ${cellRows.length} hot cells. Use response_format='json' for all._` : "")
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
