import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { fetchAllWebsites, resolveWebsiteId } from "../services/websites.js";
import { ResponseFormat, errorResult, markdownTable, textResult, toJson } from "../format.js";
import { responseFormatField, websiteField } from "../schemas.js";
import type { ActiveVisitors, DateRangeResponse, Website } from "../types.js";

export function registerWebsiteTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_list_websites",
    {
      title: "List Umami websites",
      description: `List every website tracked in this Umami account, including websites owned by teams.

Start here when you do not already know a website ID. Every other tool accepts a website ID, name, or domain, so this tool is what turns "the marketing site" into something queryable.

Args:
  - search (string, optional): Case-insensitive substring matched against name and domain.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "count": number, "websites": [ { "id": string, "name": string, "domain": string, "created_at": string, "team_id": string | null } ] }

Examples:
  - "What sites do I have in Umami?" -> no arguments
  - "Find the website for example.com" -> search="example.com"

Error handling:
  - Returns an authentication error if the API key or login is rejected.
  - Returns "No websites found" when the account has none.`,
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Optional case-insensitive substring to match against website name or domain."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ search, response_format }) => {
      try {
        const all = await fetchAllWebsites(client, true);
        const needle = search?.trim().toLowerCase();
        const websites = needle
          ? all.filter(
              (site) =>
                site.name?.toLowerCase().includes(needle) ||
                site.domain?.toLowerCase().includes(needle)
            )
          : all;

        if (websites.length === 0) {
          return textResult(
            needle
              ? `No websites matched '${search}'. Call umami_list_websites with no search argument to see all ${all.length}.`
              : "No websites found in this Umami account."
          );
        }

        const output = {
          count: websites.length,
          websites: websites.map((site: Website) => ({
            id: site.id,
            name: site.name,
            domain: site.domain,
            created_at: site.createdAt ?? null,
            team_id: site.teamId ?? null,
          })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const table = markdownTable(
          ["Name", "Domain", "ID"],
          websites.map((site) => [site.name ?? "(unnamed)", site.domain ?? "", site.id])
        );
        return textResult(`# Umami websites (${websites.length})\n\n${table}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_website",
    {
      title: "Get Umami website details",
      description: `Get configuration details for one website plus the date range of data actually collected for it.

The date range matters: querying a period before tracking started returns zeros, which is easy to misread as a traffic collapse. Check this first when numbers look surprisingly empty.

Args:
  - website (string, optional): Website ID, name, or domain.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "id": string, "name": string, "domain": string, "share_id": string | null, "created_at": string, "data_start": string | null, "data_end": string | null, "active_visitors": number }

Examples:
  - "When did we start tracking example.com?" -> website="example.com"
  - "Is anyone on the site right now?" -> website="example.com"`,
      inputSchema: {
        website: websiteField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, response_format }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const details = await client.get<Website>(`/websites/${websiteId}`);

        const [dateRange, active] = await Promise.all([
          client
            .get<DateRangeResponse>(`/websites/${websiteId}/daterange`)
            .catch(() => undefined),
          client
            .get<ActiveVisitors>(`/websites/${websiteId}/active`)
            .catch(() => undefined),
        ]);

        const output = {
          id: details.id,
          name: details.name,
          domain: details.domain,
          share_id: details.shareId ?? null,
          created_at: details.createdAt ?? null,
          reset_at: details.resetAt ?? null,
          data_start: dateRange?.startDate ?? null,
          data_end: dateRange?.endDate ?? null,
          active_visitors: active?.visitors ?? 0,
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const lines = [
          `# ${output.name} (${output.domain})`,
          "",
          `- **Website ID**: ${output.id}`,
          `- **Created**: ${output.created_at ?? "unknown"}`,
          `- **Data available**: ${
            output.data_start && output.data_end
              ? `${output.data_start} to ${output.data_end}`
              : "unknown"
          }`,
          `- **Active visitors right now**: ${output.active_visitors}`,
        ];
        if (output.share_id) lines.push(`- **Public share ID**: ${output.share_id}`);
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_active_visitors",
    {
      title: "Get active visitors",
      description: `Get the number of unique visitors active on a website in the last 5 minutes.

This is the realtime counter only. For traffic over a period use umami_get_stats.

Args:
  - website (string, optional): Website ID, name, or domain.

Returns:
  JSON shape: { "website_id": string, "active_visitors": number, "window": "last 5 minutes" }

Examples:
  - "How many people are on the site right now?" -> website="example.com"`,
      inputSchema: {
        website: websiteField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ website }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const active = await client.get<ActiveVisitors>(`/websites/${websiteId}/active`);
        return textResult(
          toJson({
            website_id: websiteId,
            active_visitors: active?.visitors ?? 0,
            window: "last 5 minutes",
          })
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
