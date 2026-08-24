#!/usr/bin/env node
/**
 * MCP server for Umami Analytics.
 *
 * Exposes read-only tools for website discovery, traffic stats, time series,
 * ranked breakdowns, custom events, and individual sessions. Works against both
 * Umami Cloud and self-hosted instances.
 *
 * Configuration (environment variables):
 *   UMAMI_API_KEY          API key. Umami Cloud, or a self-hosted key.
 *   UMAMI_BASE_URL         Root URL of a self-hosted instance, e.g. https://analytics.example.com
 *   UMAMI_USERNAME         Self-hosted login, used with UMAMI_PASSWORD instead of an API key.
 *   UMAMI_PASSWORD         Self-hosted password.
 *   UMAMI_REGION           Umami Cloud region, 'us' or 'eu'. Optional.
 *   UMAMI_TIMEZONE         IANA timezone for day boundaries, e.g. America/New_York. Default UTC.
 *   UMAMI_DEFAULT_WEBSITE  Website ID, name, or domain used when a tool call omits 'website'.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { UmamiClient, loadConfig } from "./services/client.js";
import { registerWebsiteTools } from "./tools/websites.js";
import { registerStatsTools } from "./tools/stats.js";
import { registerMetricsTools } from "./tools/metrics.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerReportTools } from "./tools/reports.js";
import { registerRawTools } from "./tools/raw.js";
import { registerAdminWebsiteTools } from "./tools/admin-websites.js";
import { registerAdminUserTools } from "./tools/admin-users.js";
import { registerAdminTeamTools } from "./tools/admin-teams.js";
import { registerProvisioningTools } from "./tools/provisioning.js";
import { registerGoalTools } from "./tools/goals.js";
import { registerFunnelTools } from "./tools/funnels.js";
import { registerReplayTools } from "./tools/replays.js";
import { registerRetentionTools } from "./tools/retention.js";
import { registerRevenueTools } from "./tools/revenue.js";
import { registerSavedReportTools } from "./tools/saved-reports.js";
import { registerSegmentTools } from "./tools/segments.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // stdio servers must never write to stdout, so configuration failures go to stderr.
    console.error(`[${SERVER_NAME}] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const client = new UmamiClient(config);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerWebsiteTools(server, client);
  registerStatsTools(server, client);
  registerMetricsTools(server, client);
  registerSessionTools(server, client);
  registerReportTools(server, client);
  registerAdminWebsiteTools(server, client);
  registerAdminUserTools(server, client);
  registerAdminTeamTools(server, client);
  registerProvisioningTools(server, client);
  registerGoalTools(server, client);
  registerFunnelTools(server, client);
  registerReplayTools(server, client);
  registerRetentionTools(server, client);
  registerRevenueTools(server, client);
  registerSavedReportTools(server, client);
  registerSegmentTools(server, client);
  registerRawTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[${SERVER_NAME}] ready. mode=${config.mode} base=${config.baseUrl} timezone=${config.timezone}` +
      (config.defaultWebsite ? ` default_website=${config.defaultWebsite}` : "")
  );
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] fatal:`, error);
  process.exit(1);
});
