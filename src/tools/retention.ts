import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { getWebsiteLabel, resolveWebsiteId } from "../services/websites.js";
import { ResponseFormat, errorResult, formatNumber, markdownTable, textResult, toJson } from "../format.js";
import { responseFormatField, websiteField } from "../schemas.js";
import type { MetricRow } from "../types.js";

const UNIT_MS: Record<string, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

async function distinctIdsInPeriod(
  client: UmamiClient,
  websiteId: string,
  startAt: number,
  endAt: number
): Promise<Set<string>> {
  const rows = await client
    .get<MetricRow[]>(`/websites/${websiteId}/metrics`, {
      startAt,
      endAt,
      type: "distinctId",
      limit: 500,
    })
    .catch(() => [] as MetricRow[]);
  return new Set((rows ?? []).map((r) => r.x).filter((x): x is string => Boolean(x)));
}

export function registerRetentionTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_get_retention",
    {
      title: "Get visitor retention across periods",
      description: `Get a cohort retention curve: of the distinct visitors seen in the first period, what percentage returned in each period since.

Umami has no retention endpoint. This is built from umami.identify()'d visitors: it groups the 'distinctId' metric dimension by period and measures overlap between the earliest period's cohort and each later period.

Requires the site to call umami.identify(persistentId) with a stable, persistent ID (e.g. a long-lived cookie or logged-in user ID). Without that, every session has a null distinctId and no cohort can be tracked, this will report zero visitors regardless of real traffic.

Args:
  - website (string, optional): Website ID, name, or domain.
  - cohort_unit ('day' | 'week' | 'month'): Length of each period, default 'week'.
  - periods (number): Number of periods to show, including period 0, default 6, max 12.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "cohort_unit": string, "cohort_size": number, "cohort_start": string, "periods": [ { "period": number, "period_start": string, "returning_visitors": number, "retention_pct": number } ] }

Error handling:
  - cohort_size of 0 means no visitor has been identify()'d yet in the earliest period. This is an instrumentation gap, not a data gap; pageview/session tools still work without identify().`,
      inputSchema: {
        website: websiteField,
        cohort_unit: z.enum(["day", "week", "month"]).default("week").describe("Length of each period."),
        periods: z.number().int().min(2).max(12).default(6).describe("Number of periods to show, including period 0."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, cohort_unit, periods, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const unitMs = UNIT_MS[cohort_unit];
        const now = Date.now();
        const cohortStart = now - periods * unitMs;

        const periodSets = await Promise.all(
          Array.from({ length: periods }, (_, i) => {
            const start = cohortStart + i * unitMs;
            const end = start + unitMs;
            return distinctIdsInPeriod(client, websiteId, start, end);
          })
        );

        const cohort = periodSets[0];
        const rows = periodSets.map((set, i) => {
          const overlap = i === 0 ? cohort.size : [...cohort].filter((id) => set.has(id)).length;
          return {
            period: i,
            period_start: new Date(cohortStart + i * unitMs).toISOString(),
            returning_visitors: overlap,
            retention_pct: cohort.size ? Number(((overlap / cohort.size) * 100).toFixed(1)) : 0,
          };
        });

        const output = {
          website_id: websiteId,
          cohort_unit,
          cohort_size: cohort.size,
          cohort_start: rows[0].period_start,
          periods: rows,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        if (cohort.size === 0) {
          return textResult(
            `# ${label}: retention\n\nNo identified visitors in the earliest ${cohort_unit} (starting ${output.cohort_start}). ` +
              "This needs umami.identify(persistentId) called on the site; without it there is no way to recognize a returning visitor."
          );
        }

        const table = markdownTable(
          ["Period", "Starts", "Returning", "Retention"],
          rows.map((r) => [r.period, r.period_start, formatNumber(r.returning_visitors), `${r.retention_pct}%`])
        );
        return textResult(
          `# ${label}: retention (${cohort_unit}ly cohort)\n\n**Cohort size**: ${formatNumber(
            cohort.size
          )} visitors first seen ${output.cohort_start}\n\n${table}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
