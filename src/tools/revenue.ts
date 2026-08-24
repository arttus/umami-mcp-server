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

interface EventDataValueRow {
  x?: string | number | null;
  y?: number;
  value?: string | number | null;
  total?: number;
  count?: number;
}

function readValue(row: EventDataValueRow): number | null {
  const raw = row.x ?? row.value;
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

function readCount(row: EventDataValueRow): number {
  return row.y ?? row.total ?? row.count ?? 0;
}

export function registerRevenueTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_get_revenue",
    {
      title: "Get revenue attributed from a custom event property",
      description: `Get total and average revenue from a numeric custom-event property, e.g. an 'amount' field on a 'purchase' event.

Self-hosted Umami has no built-in revenue tracking. This works by reading the distribution of a numeric property recorded on a custom event, via umami.track(event_name, { [property]: amount }). It sums (value x occurrence count) across every recorded value.

Args:
  - website (string, optional): Website ID, name, or domain.
  - event (string, required): Custom event name, e.g. 'purchase'.
  - property (string, required): Numeric property on that event holding the amount, e.g. 'amount'.
  - range (string): Date range, default '30d'.
  - start_date / end_date (string, optional): Explicit bounds, overriding 'range'.
  - filters (object, optional): Segment filters, e.g. { utmSource: 'google' } for revenue by campaign.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "event": string, "property": string, "total_revenue": number, "transaction_count": number, "average_value": number }

Error handling:
  - total_revenue of 0 usually means the tracker has never called umami.track(event, { property: number }) in this range, not an error. Check umami_get_metrics with type='event' to confirm the event fires at all.`,
      inputSchema: {
        website: websiteField,
        event: z.string().min(1).describe("Custom event name, e.g. 'purchase'."),
        property: z.string().min(1).describe("Numeric event property holding the amount, e.g. 'amount'."),
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
    async ({ website, event, property, range, start_date, end_date, filters, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const resolved = resolveRange({
          range: range ?? "30d",
          start_date,
          end_date,
          timezone: client.timezone,
        });

        const rows = await client.get<EventDataValueRow[]>(`/websites/${websiteId}/event-data/values`, {
          startAt: resolved.startAt,
          endAt: resolved.endAt,
          eventName: event,
          propertyName: property,
          ...filtersToParams(filters),
        });

        let totalRevenue = 0;
        let transactionCount = 0;
        for (const row of rows ?? []) {
          const value = readValue(row);
          if (value === null) continue;
          const count = readCount(row);
          totalRevenue += value * count;
          transactionCount += count;
        }

        const output = {
          website_id: websiteId,
          event,
          property,
          range: {
            start: new Date(resolved.startAt).toISOString(),
            end: new Date(resolved.endAt).toISOString(),
          },
          total_revenue: Number(totalRevenue.toFixed(2)),
          transaction_count: transactionCount,
          average_value: transactionCount ? Number((totalRevenue / transactionCount).toFixed(2)) : 0,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const label = await getWebsiteLabel(client, websiteId);
        if (transactionCount === 0) {
          return textResult(
            `# ${label}: revenue from "${event}.${property}"\n\n**Range**: ${output.range.start} to ${output.range.end}\n\n` +
              `No recorded values. Confirm the tracker calls umami.track('${event}', { ${property}: <number> }), and that the event fires in this range.`
          );
        }

        return textResult(
          `# ${label}: revenue from "${event}.${property}"\n\n**Range**: ${output.range.start} to ${output.range.end}\n\n` +
            `- Total revenue: ${formatNumber(output.total_revenue)}\n` +
            `- Transactions: ${formatNumber(transactionCount)}\n` +
            `- Average value: ${formatNumber(output.average_value)}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
