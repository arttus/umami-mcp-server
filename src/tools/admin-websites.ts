import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { fetchAllWebsites, resolveWebsiteId } from "../services/websites.js";
import { errorResult, textResult, toJson } from "../format.js";
import { confirmField, websiteField } from "../schemas.js";
import { MASK_LEVELS } from "../constants.js";
import type { Website } from "../types.js";

export function registerAdminWebsiteTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_create_website",
    {
      title: "Create a website in Umami",
      description: `Register a new website for tracking in Umami. This is the first step in onboarding a client or project: it returns a website ID that goes into the tracking script, and that every stats tool in this server uses.

Args:
  - name (string, required): Display name for the website.
  - domain (string, required): The domain being tracked, e.g. 'example.com'. No protocol.
  - team_id (string, optional): Create the website under a team instead of your personal account. Use umami_list_teams to find the ID.
  - id (string, optional): Force a specific UUID for the website, for example to match an ID reserved elsewhere.

Returns:
  JSON shape: { "id": string, "name": string, "domain": string, "team_id": string | null, "created_at": string, "tracking_snippet": string }

Examples:
  - "Set up tracking for the new client site" -> name="Walker's Land Services", domain="walkerslandservices.com"
  - "Add this under the Gradeline team" -> name="Gradeline", domain="gradeline.info", team_id="<team-uuid>"

Error handling:
  - Fails if a website with the same forced 'id' already exists.
  - Not available on Umami Cloud in read-only API-key mode without appropriate account permissions.`,
      inputSchema: {
        name: z.string().min(1).max(200).describe("Display name for the website."),
        domain: z
          .string()
          .min(1)
          .max(500)
          .describe("Domain being tracked, e.g. 'example.com'. No protocol or path."),
        team_id: z
          .string()
          .optional()
          .describe("Create under this team instead of your personal account."),
        id: z.string().optional().describe("Force a specific UUID for the website."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, domain, team_id, id }) => {
      try {
        const cleanDomain = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
        const created = await client.post<Website>("/websites", {
          name,
          domain: cleanDomain,
          ...(team_id ? { teamId: team_id } : {}),
          ...(id ? { id } : {}),
        });

        await fetchAllWebsites(client, true); // refresh cache so the new site resolves immediately

        const output = {
          id: created.id,
          name: created.name,
          domain: created.domain,
          team_id: created.teamId ?? null,
          created_at: created.createdAt ?? null,
          tracking_snippet: `<script defer src="{your-umami-instance}/script.js" data-website-id="${created.id}"></script>`,
        };

        return textResult(
          `Created website **${output.name}** (${output.domain}).\n\n` +
            `Website ID: \`${output.id}\`\n\n` +
            `Add this to the site's <head>, replacing {your-umami-instance} with your Umami URL:\n\n` +
            `\`\`\`html\n${output.tracking_snippet}\n\`\`\`\n\n${toJson(output)}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_update_website",
    {
      title: "Update a website's configuration",
      description: `Update a website's name, domain, public share link, or full session replay and heatmap configuration.

Covers every field Umami exposes for a website's recording setup, not just the on/off switches: sampling rates, PII masking strictness, max recording length, and a CSS selector to exclude sensitive elements (payment forms, etc.) from capture. Pass only the fields you want to change; anything omitted is left as-is. Use umami_get_recorder_config afterward to confirm exactly what the tracker will receive.

Args:
  - website (string, required): Website ID, name, or domain.
  - name (string, optional): New display name.
  - domain (string, optional): New domain.
  - share_id (string, optional): Set a custom share slug to enable a public dashboard link. Pass an empty string to disable sharing.
  - replay_enabled (boolean, optional): Enable or disable session replay recording.
  - heatmap_enabled (boolean, optional): Enable or disable heatmap data collection.
  - sample_rate (number, optional): Fraction of sessions to record for replay, 0 to 1.
  - heatmap_sample_rate (number, optional): Fraction of sessions to record for heatmaps, 0 to 1.
  - mask_level ('strict' | 'moderate', optional): PII masking strictness for replay recordings. 'strict' masks more aggressively.
  - max_duration_ms (number, optional): Maximum length of a single recording, in milliseconds. Umami's own docs are inconsistent about whether this field is ms or seconds; umami_get_recorder_config after saving shows the effective value the tracker will actually use.
  - block_selector (string, optional): CSS selector for elements to exclude entirely from replay capture, e.g. '.payment-form, [data-sensitive]'.

Returns:
  JSON shape: { "id": string, "name": string, "domain": string, "share_id": string | null, "replay_config": { "replayEnabled": boolean, "heatmapEnabled": boolean, "sampleRate": number, "heatmapSampleRate": number, "maskLevel": string, "maxDuration": number, "blockSelector": string } | null }

Examples:
  - "Turn on session replay for the Gradeline site at 20% sampling" -> replay_enabled=true, sample_rate=0.2
  - "Enable heatmaps too, sampled lighter than replay" -> heatmap_enabled=true, heatmap_sample_rate=0.1
  - "Mask more aggressively and exclude the payment form from recordings" -> mask_level="strict", block_selector=".payment-form"
  - "Give this site a public share link" -> share_id="lha-public-dashboard"
  - "Turn off the public link" -> share_id=""`,
      inputSchema: {
        website: websiteField,
        name: z.string().min(1).max(200).optional().describe("New display name."),
        domain: z.string().min(1).max(500).optional().describe("New domain."),
        share_id: z
          .string()
          .optional()
          .describe("Custom share slug to enable a public dashboard link. Empty string disables sharing."),
        replay_enabled: z.boolean().optional().describe("Enable or disable session replay recording."),
        heatmap_enabled: z.boolean().optional().describe("Enable or disable heatmap data collection."),
        sample_rate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fraction of sessions to record for replay, 0 to 1."),
        heatmap_sample_rate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fraction of sessions to record for heatmaps, 0 to 1."),
        mask_level: z
          .enum(MASK_LEVELS)
          .optional()
          .describe("PII masking strictness for replay recordings."),
        max_duration_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum length of a single recording, in milliseconds."),
        block_selector: z
          .string()
          .optional()
          .describe("CSS selector for elements to exclude entirely from replay capture."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      website,
      name,
      domain,
      share_id,
      replay_enabled,
      heatmap_enabled,
      sample_rate,
      heatmap_sample_rate,
      mask_level,
      max_duration_ms,
      block_selector,
    }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);

        const replayConfig: Record<string, unknown> = {};
        if (replay_enabled !== undefined) replayConfig.replayEnabled = replay_enabled;
        if (heatmap_enabled !== undefined) replayConfig.heatmapEnabled = heatmap_enabled;
        if (sample_rate !== undefined) replayConfig.sampleRate = sample_rate;
        if (heatmap_sample_rate !== undefined) replayConfig.heatmapSampleRate = heatmap_sample_rate;
        if (mask_level !== undefined) replayConfig.maskLevel = mask_level;
        if (max_duration_ms !== undefined) replayConfig.maxDuration = max_duration_ms;
        if (block_selector !== undefined) replayConfig.blockSelector = block_selector;
        const hasReplayConfig = Object.keys(replayConfig).length > 0;

        if (
          name === undefined &&
          domain === undefined &&
          share_id === undefined &&
          !hasReplayConfig
        ) {
          return errorResult(
            "Error: nothing to update. Pass at least one of name, domain, share_id, or a replay/heatmap field."
          );
        }

        const updated = await client.post<Website & { replayConfig?: Record<string, unknown> }>(
          `/websites/${websiteId}`,
          {
            ...(name !== undefined ? { name } : {}),
            ...(domain !== undefined ? { domain } : {}),
            ...(share_id !== undefined ? { shareId: share_id || null } : {}),
            ...(hasReplayConfig ? { replayConfig } : {}),
          }
        );

        await fetchAllWebsites(client, true);

        return textResult(
          `Updated **${updated.name}** (${updated.domain}).\n\n${toJson({
            id: updated.id,
            name: updated.name,
            domain: updated.domain,
            share_id: updated.shareId ?? null,
            replay_config: updated.replayConfig ?? null,
          })}` +
            (hasReplayConfig
              ? "\n\nRun umami_get_recorder_config to confirm the effective values the tracker will use, especially max_duration_ms."
              : "")
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_recorder_config",
    {
      title: "Get the live session replay / heatmap config",
      description: `Get the recorder configuration Umami is actually serving to the tracker for a website: whether replay and heatmaps are enabled, sample rates, masking level, max duration, and the block selector.

This reads the same public endpoint the tracker script itself calls, so it is the ground truth after umami_update_website changes replay or heatmap settings, useful for confirming values actually took effect and resolving any unit ambiguity on max duration.

Args:
  - website (string, optional): Website ID, name, or domain.

Returns:
  JSON shape: { "enabled": boolean, "replay_enabled": boolean, "heatmap_enabled": boolean, "sample_rate": number, "heatmap_sample_rate": number, "mask_level": string, "max_duration": number, "block_selector": string }

Examples:
  - "Did the replay settings actually save?" -> website="example.com"`,
      inputSchema: {
        website: websiteField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website }) => {
      try {
        const websiteId = await resolveWebsiteId(client, website);
        const raw = await client.get<{
          enabled: boolean;
          replayEnabled?: boolean;
          heatmapEnabled?: boolean;
          sampleRate?: number;
          heatmapSampleRate?: number;
          maskLevel?: string;
          maxDuration?: number;
          blockSelector?: string;
        }>(`/websites/${websiteId}/recorder`);

        if (!raw?.enabled) {
          return textResult(
            toJson({ enabled: false }) +
              "\n\nRecording is off for this website (or it does not exist). Enable it with umami_update_website's replay_enabled or heatmap_enabled."
          );
        }

        return textResult(
          toJson({
            enabled: true,
            replay_enabled: raw.replayEnabled ?? false,
            heatmap_enabled: raw.heatmapEnabled ?? false,
            sample_rate: raw.sampleRate ?? null,
            heatmap_sample_rate: raw.heatmapSampleRate ?? null,
            mask_level: raw.maskLevel ?? null,
            max_duration: raw.maxDuration ?? null,
            block_selector: raw.blockSelector ?? "",
          })
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_reset_website",
    {
      title: "Reset a website (delete all data)",
      description: `Permanently delete all collected data for a website: every pageview, session, and event. The website registration and tracking ID are kept, so the tracking script keeps working and data collection starts fresh.

This cannot be undone. Requires confirm=true.

Args:
  - website (string, required): Website ID, name, or domain.
  - confirm (boolean, required): Must be true. There is no undo.

Returns:
  { "ok": true, "website_id": string }

Examples:
  - "Wipe the test data we collected before going live" -> website="example.com", confirm=true`,
      inputSchema: {
        website: websiteField,
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, confirm }) => {
      try {
        if (confirm !== true) {
          return errorResult("Error: confirm must be true. This permanently deletes all collected data.");
        }
        const websiteId = await resolveWebsiteId(client, website);
        await client.post(`/websites/${websiteId}/reset`);
        return textResult(toJson({ ok: true, website_id: websiteId }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_delete_website",
    {
      title: "Delete a website",
      description: `Permanently delete a website registration and all of its collected data from Umami.

This cannot be undone. Requires confirm=true. To keep the registration and tracking ID but clear historical data, use umami_reset_website instead.

Args:
  - website (string, required): Website ID, name, or domain.
  - confirm (boolean, required): Must be true. There is no undo.

Returns:
  { "ok": true, "website_id": string }

Examples:
  - "Remove the old staging site from Umami entirely" -> website="staging.example.com", confirm=true`,
      inputSchema: {
        website: websiteField,
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ website, confirm }) => {
      try {
        if (confirm !== true) {
          return errorResult("Error: confirm must be true. This permanently deletes the website and all its data.");
        }
        const websiteId = await resolveWebsiteId(client, website);
        await client.delete(`/websites/${websiteId}`);
        await fetchAllWebsites(client, true);
        return textResult(toJson({ ok: true, website_id: websiteId }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
