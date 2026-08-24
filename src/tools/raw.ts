import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { errorResult, textResult, toJson } from "../format.js";

/**
 * A read-only escape hatch. Umami's API surface is larger than the dedicated
 * tools here (reports, teams, links, pixels, session data properties, weekly
 * heatmaps), and it changes between versions. Rather than guess at schemas,
 * expose a constrained GET so an agent can reach any documented endpoint.
 */
export function registerRawTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_api_get",
    {
      title: "Raw Umami API GET",
      description: `Make a read-only GET request against any Umami API endpoint that does not have a dedicated tool here.

Use this only as a fallback. The dedicated tools handle date parsing, website resolution, and formatting; this one does not. It is the right choice for endpoints such as /websites/:id/sessions/weekly, /websites/:id/session-data/properties, /websites/:id/session-data/values, /reports, /teams, /me, and anything added in a newer Umami release.

Timestamps in params must be epoch milliseconds, and website IDs must be UUIDs. Only GET is permitted, so this tool cannot create, update, or delete anything.

Args:
  - path (string, required): API path relative to the API root, for example '/websites/abc-123/sessions/weekly'. Do not include the /api prefix or the host.
  - params (object, optional): Query string parameters as string values, for example { startAt: '1735689600000', endAt: '1738368000000', timezone: 'America/New_York' }.

Returns:
  The raw JSON response from Umami, pretty-printed.

Examples:
  - Weekly session heatmap: path="/websites/<uuid>/sessions/weekly", params={ startAt: "...", endAt: "...", timezone: "America/New_York" }
  - Session property names: path="/websites/<uuid>/session-data/properties", params={ startAt: "...", endAt: "..." }
  - Current user: path="/me"

Error handling:
  - Rejects any path containing a query string; put parameters in 'params' instead.
  - Returns the Umami status code and path on failure, so a 404 usually means the endpoint does not exist on this Umami version.`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "API path relative to the API root, starting with '/'. Example: '/websites/<uuid>/sessions/weekly'."
          ),
        params: z
          .record(z.string())
          .optional()
          .describe("Query string parameters as string values."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, params }) => {
      try {
        const trimmed = path.trim();

        if (trimmed.includes("?")) {
          return errorResult(
            "Error: the 'path' argument must not contain a query string. Move those values into the 'params' object."
          );
        }
        if (/^https?:\/\//i.test(trimmed)) {
          return errorResult(
            "Error: pass a path relative to the API root, not a full URL. Example: '/websites/<uuid>/stats'."
          );
        }
        if (trimmed.includes("..")) {
          return errorResult("Error: the 'path' argument must not contain '..'.");
        }

        const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
        const withoutApiPrefix = normalized.replace(/^\/api(?=\/)/, "");

        const data = await client.get<unknown>(withoutApiPrefix, params);
        return textResult(toJson(data ?? null));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
