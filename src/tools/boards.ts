import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { errorResult, markdownTable, textResult, toJson, ResponseFormat } from "../format.js";
import { confirmField, responseFormatField, websiteField } from "../schemas.js";
import type { Paged } from "../types.js";

/**
 * Umami 3.x "Boards" are the user-built dashboards (Boards in the sidebar). Like
 * saved reports, they are not in the documented REST API; the shapes below come
 * from Umami's source (src/app/api/boards, src/lib/types.ts BoardParameters, and
 * boardComponentRegistry.tsx) and a live 400 from POST /api/boards. Unofficial,
 * could change on an Umami upgrade.
 *
 * A board is { type, name, description, parameters }. For a 'website' board,
 * parameters = { websiteId, rows: [{ id, columns: [{ id, component }] }] } and each
 * component = { type, title?, description?, props? }. Goal and Funnel widgets point
 * at a saved report through props.reportId (see umami_create_goal / umami_create_funnel).
 */

const WIDGET_TYPES = [
  "WebsiteMetricsBar",
  "EventsMetricsBar",
  "Goal",
  "Funnel",
  "WebsiteChart",
  "UTM",
  "RealtimeHeader",
  "RealtimeChart",
  "RealtimeActiveUsers",
  "RevenueMetricsBar",
  "RevenueChart",
  "RevenueMetricsTable",
  "MetricsTable",
  "WorldMap",
  "WeeklyTraffic",
  "EventsChart",
  "TextBlock",
] as const;

const widgetField = z.object({
  type: z.enum(WIDGET_TYPES).describe("Widget type."),
  title: z.string().optional().describe("Optional heading shown on the widget."),
  website: z
    .string()
    .optional()
    .describe("Website ID, name, or domain for this widget. Dashboard only; boards use their own website."),
  report_id: z
    .string()
    .optional()
    .describe("Saved report ID. Required for Goal and Funnel widgets (from umami_list_saved_reports)."),
  props: z
    .record(z.unknown())
    .optional()
    .describe(
      "Widget settings. MetricsTable: { type: 'path'|'referrer'|'country'|'browser'|'os'|'device'|'event'|..., limit: 5|10|20 }. UTM: { param: 'utm_source'|'utm_medium'|'utm_campaign'|'utm_content'|'utm_term', limit }. Revenue widgets: { currency: 'USD' }. TextBlock: { text }."
    ),
});

const rowsField = z
  .array(z.array(widgetField).min(1).max(4))
  .min(1)
  .max(20)
  .describe("Layout, top to bottom. Each row is a list of 1-4 widgets laid out side by side.");

export type Widget = z.infer<typeof widgetField>;

// ponytail: widgets on the home dashboard carry their own websiteId (resolved by the caller).
export function buildRows(rows: Widget[][], siteIds: Map<string, string> = new Map()) {
  return rows.map((row) => ({
    id: randomUUID(),
    columns: row.map((w) => ({
      id: randomUUID(),
      component: {
        type: w.type,
        ...(w.title ? { title: w.title } : {}),
        ...(w.website ? { websiteId: siteIds.get(w.website) } : {}),
        props: { ...(w.props ?? {}), ...(w.report_id ? { reportId: w.report_id } : {}) },
      },
    })),
  }));
}

export const table = (type: string, limit = 10): Widget => ({ type: "MetricsTable", props: { type, limit } });
const PRESETS = {
  overview: [
    [{ type: "WebsiteMetricsBar" }],
    [{ type: "WebsiteChart" }],
    [table("path"), table("referrer")],
    [table("country"), { type: "WorldMap" }],
    [table("browser"), table("os"), table("device")],
    [{ type: "WeeklyTraffic" }],
  ],
  acquisition: [
    [{ type: "WebsiteMetricsBar" }],
    [{ type: "WebsiteChart" }],
    [table("channel"), table("referrer")],
    [{ type: "UTM", props: { param: "utm_source", limit: 10 } }, { type: "UTM", props: { param: "utm_campaign", limit: 10 } }],
    [{ type: "UTM", props: { param: "utm_medium", limit: 10 } }, { type: "UTM", props: { param: "utm_term", limit: 10 } }],
  ],
  behavior: [
    [{ type: "EventsMetricsBar" }],
    [{ type: "EventsChart" }],
    [table("event"), table("path")],
    [table("entry"), table("exit")],
  ],
  realtime: [[{ type: "RealtimeHeader" }], [{ type: "RealtimeChart" }], [{ type: "RealtimeActiveUsers" }]],
  revenue: [[{ type: "RevenueMetricsBar" }], [{ type: "RevenueChart" }], [{ type: "RevenueMetricsTable" }]],
} satisfies Record<string, Widget[][]>;

const presetField = z
  .enum(Object.keys(PRESETS) as [keyof typeof PRESETS, ...(keyof typeof PRESETS)[]])
  .optional()
  .describe(
    "Ready-made layout instead of rows: overview (KPIs, traffic chart, top pages/referrers, map, devices, weekly heatmap), acquisition (channels, referrers, UTM), behavior (events, entry/exit pages), realtime, revenue."
  );

export function checkRows(rows: Widget[][]): string | undefined {
  for (const w of rows.flat()) {
    if ((w.type === "Goal" || w.type === "Funnel") && !w.report_id) {
      return `Error: ${w.type} widgets need report_id. Create one with umami_create_${w.type.toLowerCase()} and use its id.`;
    }
  }
  return undefined;
}

export interface Board {
  id: string;
  type: string;
  name: string;
  description: string;
  parameters: { websiteId?: string; rows?: { columns?: { component?: { type?: string } }[] }[] };
  createdAt: string;
}

export function summarize(b: Board) {
  const widgets = (b.parameters?.rows ?? []).flatMap((r) => (r.columns ?? []).map((c) => c.component?.type ?? "?"));
  return { id: b.id, name: b.name, type: b.type, website_id: b.parameters?.websiteId ?? null, widgets, created_at: b.createdAt };
}

export function registerBoardTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_list_boards",
    {
      title: "List dashboards (boards)",
      description: `List the dashboards (Boards) visible to the logged-in user, with the widget types each one contains.

Args:
  - response_format ('markdown' | 'json'): default 'markdown'.

Returns:
  JSON shape: { "boards": [ { "id", "name", "type", "website_id", "widgets": string[], "created_at" } ] }`,
      inputSchema: { response_format: responseFormatField },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      try {
        const result = await client.get<Paged<Board>>("/boards", { pageSize: 100 });
        const boards = (result?.data ?? []).map(summarize);
        if (boards.length === 0) return textResult("No dashboards (boards) yet.");
        if (response_format === ResponseFormat.JSON) return textResult(toJson({ boards }));
        return textResult(
          markdownTable(
            ["ID", "Name", "Type", "Widgets"],
            boards.map((b) => [b.id, b.name, b.type, b.widgets.join(", ")])
          )
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_create_board",
    {
      title: "Create a dashboard (board) in the Umami UI",
      description: `Create a persisted dashboard for one website. It appears under Boards in the Umami web UI.

Args:
  - website (string, optional): Website ID, name, or domain.
  - name (string, required): Dashboard name (max 100 chars).
  - description (string, optional).
  - preset (string, optional): ready-made layout, e.g. 'overview'. Use this or rows.
  - rows (array, optional): Layout, top to bottom. Each row is 1-4 widgets side by side. Widget: { type, title?, report_id?, props? }.
    Types: ${WIDGET_TYPES.join(", ")}.
    Goal and Funnel widgets require report_id of a saved goal/funnel.

Returns:
  { "id", "name", "type", "website_id", "widgets", "created_at" }

Examples:
  - Overview: rows=[[{type:'WebsiteMetricsBar'}],[{type:'WebsiteChart'}],[{type:'MetricsTable',props:{type:'path',limit:10}},{type:'MetricsTable',props:{type:'referrer',limit:10}}],[{type:'WorldMap'}]]`,
      inputSchema: {
        website: websiteField,
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        preset: presetField,
        rows: rowsField.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ website, name, description, preset, rows: given }) => {
      const rows = given ?? (preset ? PRESETS[preset] : undefined);
      if (!rows) return errorResult("Error: pass preset or rows.");
      const problem = checkRows(rows);
      if (problem) return errorResult(problem);
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const created = await client.post<Board>("/boards", {
          type: "website",
          name,
          description: description ?? "",
          parameters: { websiteId, rows: buildRows(rows) },
        });
        const label = await getWebsiteLabel(client, websiteId);
        return textResult(`Created dashboard "${created.name}" (${created.id}) for ${label}. Visible now under Boards in the Umami UI.\n\n${toJson(summarize(created))}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_update_board",
    {
      title: "Rename or re-layout a dashboard (board)",
      description: `Update a dashboard's name, description, or layout. Passing rows REPLACES the whole layout; the website stays the same. Get board_id from umami_list_boards.

Args:
  - board_id (string, required)
  - name, description (string, optional)
  - preset / rows (optional): same as umami_create_board.`,
      inputSchema: {
        board_id: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        preset: presetField,
        rows: rowsField.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ board_id, name, description, preset, rows: given }) => {
      const rows = given ?? (preset ? PRESETS[preset] : undefined);
      if (rows) {
        const problem = checkRows(rows);
        if (problem) return errorResult(problem);
      }
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (rows) {
          const current = await client.get<Board | null>(`/boards/${board_id}`);
          if (!current) return errorResult(`Error: no board ${board_id}.`);
          body.parameters = { ...current.parameters, rows: buildRows(rows) };
        }
        if (Object.keys(body).length === 0) return errorResult("Error: pass name, description, or rows.");
        const updated = await client.post<Board>(`/boards/${board_id}`, body);
        return textResult(toJson(summarize(updated)));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_delete_board",
    {
      title: "Delete a dashboard (board)",
      description: `Permanently delete a dashboard. Saved goals, funnels and the website's data are not touched. Requires confirm=true. Get board_id from umami_list_boards.`,
      inputSchema: { board_id: z.string().min(1), confirm: confirmField },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ board_id, confirm }) => {
      if (confirm !== true) return errorResult("Error: confirm must be true. This permanently deletes the dashboard.");
      try {
        await client.delete(`/boards/${board_id}`);
        return textResult(toJson({ ok: true, board_id }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_dashboard",
    {
      title: "Get the home dashboard",
      description: `Read the logged-in user's home dashboard (the page Umami opens on login). It is separate from Boards: one per user, and its widgets can come from different websites. Returns null when it has never been set.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const d = await client.get<Board | null>("/dashboard");
        return textResult(d ? toJson({ ...summarize(d), parameters: d.parameters }) : "Home dashboard is empty (never set).");
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_set_dashboard",
    {
      title: "Build the home dashboard",
      description: `Set the home dashboard, REPLACING its current layout. Two modes:
  - websites + preset: one stacked section per website (KPI bar, traffic chart, then the preset's widgets). Good for a multi-site command center.
  - rows: custom layout; every widget needs its own 'website'.

Args:
  - websites (string[], optional): Website IDs, names, or domains (max 6).
  - compact_websites (string[], optional): secondary sites shown after those, as a KPI bar only.
  - preset (string, optional): ${Object.keys(PRESETS).join(", ")}. Default 'overview'.
  - rows (array, optional): custom layout, each widget with 'website'. Overrides websites/preset.
  - name (string, optional): default 'Dashboard'.`,
      inputSchema: {
        websites: z.array(z.string().min(1)).min(1).max(6).optional(),
        compact_websites: z.array(z.string().min(1)).max(10).optional().describe("Secondary sites, listed after 'websites' as just a KPI bar."),
        preset: presetField,
        layout: z.enum(["compact", "detailed"]).default("compact").describe("compact (default): main sites side by side as columns (KPIs, chart, top 5 pages and referrers), secondary sites as a KPI row below. detailed: one full preset section per site, stacked."),
        rows: rowsField.optional(),
        name: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ websites, compact_websites, preset, layout, rows: given, name }) => {
      try {
        let rows: Widget[][];
        if (given) {
          const missing = given.flat().find((w) => !w.website && w.type !== "TextBlock");
          if (missing) return errorResult(`Error: ${missing.type} widget needs 'website' on the home dashboard.`);
          rows = given;
        } else {
          if (!websites) return errorResult("Error: pass websites (with optional preset) or rows.");
          rows = [];
          const chunk = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / 4) }, (_, i) => a.slice(i * 4, i * 4 + 4));
          const strip = (sites: string[]) => {
            for (const group of chunk(sites)) {
              rows.push(group.map((w) => ({ type: "WebsiteMetricsBar", website: w })));
            }
          };
          if (layout === "compact") {
            // ponytail: ignores 'preset'; fixed 5-row-per-site grid, one site per column (4 columns max)
            const cols: ((s: string) => Widget)[] = [(w) => ({ type: "WebsiteMetricsBar", website: w }), (w) => ({ type: "WebsiteChart", website: w }), (w) => ({ ...table("path", 5), website: w }), (w) => ({ ...table("referrer", 5), website: w })];
            for (const group of chunk(websites)) for (const make of cols) rows.push(group.map(make));
          } else {
            for (const site of websites) {
              for (const r of PRESETS[preset ?? "overview"]) rows.push(r.map((w) => ({ ...w, website: site })));
            }
          }
          strip(compact_websites ?? []);
        }
        const problem = checkRows(rows);
        if (problem) return errorResult(problem);
        const siteIds = new Map<string, string>();
        for (const w of rows.flat()) if (w.website && !siteIds.has(w.website)) siteIds.set(w.website, await resolveWebsiteId(client, w.website));
        const saved = await client.post<Board>("/dashboard", {
          name: name ?? "Dashboard",
          description: "", // Umami 500s on /dashboard when description is omitted (NOT NULL column)
          parameters: { rows: buildRows(rows, siteIds) },
        });
        return textResult(`Home dashboard set (${rows.flat().length} widgets). Reload Umami to see it.\n\n${toJson(summarize(saved))}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
