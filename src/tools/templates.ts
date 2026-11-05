import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { fetchAllWebsites, resolveWebsiteId } from "../services/websites.js";
import { resolveRange } from "../services/dates.js";
import { errorResult, textResult, toJson } from "../format.js";
import { websiteField } from "../schemas.js";
import type { Paged, SavedReport } from "../types.js";
import { buildRows, table, summarize, type Board, type Widget } from "./boards.js";

/**
 * Opinionated one-call dashboards. Each template looks at what the website really
 * tracks, reuses saved goals/funnels that already exist, creates only what is
 * missing, then builds (or rebuilds) one board. Re-running is safe: a board with the
 * same name is updated in place instead of duplicated.
 *
 * Umami has no retention or journey widget, so the product template leans on
 * realtime, events and engagement instead.
 */

const TEMPLATES = {
  leadgen: "Lead-gen",
  product: "Product",
  client_report: "Client report",
} as const;

// Event names that usually mean "someone converted". Used only to suggest, when conversions is omitted.
// Anyone who can reach a site's tracker can send an event with any name, so a name from analytics is
// untrusted: it must look like a plain identifier and have real volume before it is even suggested.
const CONVERSION_HINT = /(submit|complete|verified|signup|sign_up|purchase|order|book|checkout|thank|tel_click|call_click|quote|lead_start)/i;
const SAFE_EVENT = /^[a-z0-9_.-]{1,50}$/i;
const MIN_EVENT_COUNT = 3;

const chunk = <T,>(a: T[], n = 4) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function registerTemplateTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_build_template",
    {
      title: "Build an opinionated dashboard for a website",
      description: `One call builds a finished board for a website, using what it actually tracks.

Templates:
  - leadgen: KPIs, goal widgets for conversion events, funnel(s), traffic chart, UTM sources and campaigns, channels, landing pages, top events. Reuses existing goals and funnels; creates goals only for event names you pass in conversions.
  - product: KPIs, live visitors, events chart and tables, top pages, weekly traffic. No retention widget exists in Umami, so it uses realtime and events.
  - client_report: a clean shareable board (KPIs, chart, pages, referrers, countries, devices, map). Set public_share=true to also create a public read-only link; anyone with it can view the board.

Args:
  - website (string, optional): Website ID, name, or domain.
  - template ('leadgen' | 'product' | 'client_report', required)
  - conversions (string[], optional): leadgen only. Event names to make goals from (letters, digits, _ . - only, max 50 chars). If omitted, it shows the goals already saved on the site and only SUGGESTS conversion-looking events from the last 90 days without creating anything, because event names come from public tracker traffic and are untrusted.
  - funnel_steps (string[], optional): leadgen only. Ordered page paths ('/audit') or event names; creates a funnel named funnel_name if none with that name exists. Items starting with '/' are pages.
  - funnel_name (string, optional): default 'Main funnel'.
  - public_share (true, optional): client_report only. Creates a public share link.
  - dry_run (boolean): default false. Show what would be created without writing anything.

Returns: what was reused, created, and the board.`,
      inputSchema: {
        website: websiteField,
        template: z.enum(["leadgen", "product", "client_report"]),
        conversions: z.array(z.string().regex(SAFE_EVENT, "letters, digits, _ . - only, max 50 chars")).max(8).optional(),
        funnel_steps: z.array(z.string().min(1)).min(2).max(8).optional(),
        funnel_name: z.string().min(1).max(100).default("Main funnel"),
        public_share: z.literal(true).optional(),
        dry_run: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ website, template, conversions, funnel_steps, funnel_name, public_share, dry_run }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const label = (await fetchAllWebsites(client)).find((w) => w.id === websiteId)?.name ?? websiteId;
        const log: string[] = [];
        const rows: Widget[][] = [];
        const kpi: Widget = { type: "WebsiteMetricsBar" };
        const chart: Widget = { type: "WebsiteChart" };

        if (template === "leadgen") {
          const saved = async (type: "goal" | "funnel") => (await client.get<Paged<SavedReport>>("/reports", { websiteId, type }))?.data ?? [];
          const [goals, funnels] = [await saved("goal"), await saved("funnel")];

          const goalWidgets: Widget[] = [];
          let events = conversions;
          if (!events) {
            // No explicit list: show the goals already saved on the site, then top up with conversion-looking events.
            for (const g of goals.slice(0, 4)) goalWidgets.push({ type: "Goal", title: g.name, report_id: g.id });
            if (goals.length) log.push(`Reused saved goals: ${goals.slice(0, 4).map((g) => g.name).join(", ")}`);
            const { startAt, endAt } = resolveRange({ range: "90d", timezone: client.timezone });
            const top = await client.get<{ x: string; y: number }[]>(`/websites/${websiteId}/metrics`, { type: "event", startAt, endAt, limit: 50 });
            const known = new Set(goals.map((g) => (g.parameters as { value?: string }).value));
            // Suggest only. A saved goal made from a name nobody vetted is a write, so it needs an explicit conversions list.
            const suggested = (top ?? [])
              .filter((r) => typeof r.x === "string" && SAFE_EVENT.test(r.x) && CONVERSION_HINT.test(r.x) && r.y >= MIN_EVENT_COUNT && !known.has(r.x))
              .map((r) => r.x)
              .slice(0, 4);
            if (suggested.length) log.push(`Not created. Events that look like conversions (untrusted names from your analytics): ${JSON.stringify(suggested)}. Pass conversions=[...] to make goals from them.`);
            else if (!goals.length) log.push("No saved goals and no conversion-looking events found. Pass conversions=[...] to choose.");
            events = [];
          }

          for (const ev of events) {
            const existing = goals.find((g) => (g.parameters as { value?: string }).value === ev);
            let id = existing?.id;
            if (existing) log.push(`Reused goal "${existing.name}"`);
            else if (dry_run) log.push(`Would create goal "${ev}"`);
            else {
              id = (await client.post<SavedReport>("/reports", { type: "goal", name: ev, websiteId, description: "", parameters: { type: "event", value: ev } })).id;
              log.push(`Created goal "${ev}"`);
            }
            if (id) goalWidgets.push({ type: "Goal", title: existing?.name ?? ev, report_id: id });
          }

          const funnelWidgets: Widget[] = funnels.slice(0, 2).map((f) => ({ type: "Funnel", title: f.name, report_id: f.id }));
          if (funnel_steps && !funnels.some((f) => f.name === funnel_name)) {
            if (dry_run) log.push(`Would create funnel "${funnel_name}"`);
            else {
              const steps = funnel_steps.map((v) => ({ type: v.startsWith("/") ? "path" : "event", value: v, filters: [] }));
              const f = await client.post<SavedReport>("/reports", { type: "funnel", name: funnel_name, websiteId, description: "", parameters: { steps, window: 60 } });
              funnelWidgets.unshift({ type: "Funnel", title: funnel_name, report_id: f.id });
              log.push(`Created funnel "${funnel_name}"`);
            }
          } else if (funnelWidgets.length) log.push(`Reused funnel(s): ${funnelWidgets.map((f) => f.title).join(", ")}`);

          rows.push([kpi]);
          for (const g of chunk(goalWidgets)) rows.push(g);
          if (funnelWidgets.length) rows.push(funnelWidgets.slice(0, 2));
          rows.push([chart]);
          rows.push([{ type: "UTM", title: "UTM source", props: { param: "utm_source", limit: 10 } }, { type: "UTM", title: "UTM campaign", props: { param: "utm_campaign", limit: 10 } }]);
          rows.push([table("channel"), table("entry")]);
          rows.push([table("event"), table("referrer")]);
        } else if (template === "product") {
          rows.push([kpi, { type: "RealtimeActiveUsers" }]);
          rows.push([chart]);
          rows.push([{ type: "EventsMetricsBar" }]);
          rows.push([{ type: "EventsChart" }]);
          rows.push([table("event"), table("path")]);
          rows.push([table("device"), table("browser"), table("os")]);
          rows.push([{ type: "WeeklyTraffic" }]);
        } else {
          rows.push([kpi]);
          rows.push([chart]);
          rows.push([table("path"), table("referrer")]);
          rows.push([table("country"), table("device")]);
          rows.push([{ type: "WorldMap" }]);
        }

        const name = `${label} ${TEMPLATES[template]}`;
        const parameters = { websiteId, rows: buildRows(rows) };
        // Same name on a different website is a different board: never rewrite one site's board with another's layout.
        const existing = (await client.get<Paged<Board>>("/boards", { pageSize: 100 }))?.data?.find((b) => b.name === name && b.parameters?.websiteId === websiteId);

        if (dry_run) {
          return textResult(`DRY RUN, nothing written.\n${log.join("\n")}\n${existing ? "Would update" : "Would create"} board "${name}" with ${rows.flat().length} widgets: ${rows.flat().map((w) => w.type).join(", ")}`);
        }

        if (existing) {
          const shares = await client.get<Paged<unknown>>(`/boards/${existing.id}/shares`).catch(() => undefined);
          if (shares?.count) log.push(`Heads up: this board has ${shares.count} public share link(s). The update is visible there.`);
        }
        const board = existing
          ? await client.post<Board>(`/boards/${existing.id}`, { parameters })
          : await client.post<Board>("/boards", { type: "website", name, description: "", parameters });
        log.push(existing ? `Updated board "${name}"` : `Created board "${name}"`);

        let share: unknown;
        if (template === "client_report" && public_share) {
          share = await client.post("/share", { entityId: board.id, shareType: 4, name, parameters: {} });
          log.push("Created public share link");
        }
        return textResult(`${log.join("\n")}\n\n${toJson({ board: summarize(board), ...(share ? { share } : {}) })}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
