import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { fetchAllWebsites } from "../services/websites.js";
import { errorResult, textResult, toJson } from "../format.js";
import { TEAM_MEMBER_ROLES, MASK_LEVELS } from "../constants.js";
import type { Team, TeamMember, User, Website } from "../types.js";

export function registerProvisioningTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_onboard_client",
    {
      title: "Onboard a client: website, team, and access in one call",
      description: `Set up everything Umami needs for a new client or project in a single call: register the website, optionally create a dedicated team for it, and optionally grant an existing internal user access to that team.

This is the fast path for "get this new site tracked and set up properly." For anything more custom, for example multiple websites under one team, use umami_create_website, umami_create_team, and umami_add_team_user individually.

Args:
  - website_name (string, required): Display name for the website.
  - domain (string, required): Domain being tracked, e.g. 'example.com'. No protocol.
  - team_name (string, optional): If given, creates a new team with this name and puts the website under it. Omit to create the website under your personal account instead.
  - grant_user_id (string, optional): An existing internal user (from umami_list_users) to add to the new team.
  - grant_role ('team-manager' | 'team-member' | 'team-view-only'): Role for grant_user_id on the new team (default: 'team-manager'). Ignored if grant_user_id or team_name is omitted.
  - replay_enabled (boolean, optional): Turn on session replay recording for the new website.
  - heatmap_enabled (boolean, optional): Turn on heatmap collection for the new website.
  - sample_rate (number, optional): Fraction of sessions to record for replay, 0 to 1. Only applied if replay_enabled or heatmap_enabled is set.
  - mask_level ('strict' | 'moderate', optional): PII masking strictness for replay recordings.

Returns:
  JSON shape: {
    "website": { "id": string, "name": string, "domain": string },
    "team": { "id": string, "name": string, "access_code": string } | null,
    "granted_user": { "id": string, "username": string, "role": string } | null,
    "replay_config": { "replayEnabled": boolean, "heatmapEnabled": boolean, "sampleRate": number, "maskLevel": string } | null,
    "tracking_snippet": string
  }

Examples:
  - "Set up tracking for the new Walker's Land Services site, its own team, and add jordan to it" -> website_name="Walker's Land Services", domain="walkerslandservices.com", team_name="Walker's Land Services", grant_user_id="<jordan's user id>"
  - "Just get this client tracked, no team needed" -> website_name="...", domain="..."
  - "Set it up with replay on at 15% from day one" -> website_name="...", domain="...", replay_enabled=true, sample_rate=0.15

Error handling:
  - If website creation succeeds but team creation fails, the website still exists; the response reports the partial result rather than leaving it unclear.
  - If the website is created but the replay/heatmap follow-up update fails, the website and team (if any) still exist; use umami_update_website to finish that step manually.`,
      inputSchema: {
        website_name: z.string().min(1).max(200).describe("Display name for the website."),
        domain: z
          .string()
          .min(1)
          .max(500)
          .describe("Domain being tracked, e.g. 'example.com'. No protocol or path."),
        team_name: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Create a new team with this name and put the website under it."),
        grant_user_id: z
          .string()
          .optional()
          .describe("Existing internal user to add to the new team."),
        grant_role: z
          .enum(TEAM_MEMBER_ROLES)
          .default("team-manager")
          .describe("Role for grant_user_id on the new team."),
        replay_enabled: z.boolean().optional().describe("Turn on session replay recording for the new website."),
        heatmap_enabled: z.boolean().optional().describe("Turn on heatmap collection for the new website."),
        sample_rate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Fraction of sessions to record for replay, 0 to 1."),
        mask_level: z
          .enum(MASK_LEVELS)
          .optional()
          .describe("PII masking strictness for replay recordings."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      website_name,
      domain,
      team_name,
      grant_user_id,
      grant_role,
      replay_enabled,
      heatmap_enabled,
      sample_rate,
      mask_level,
    }) => {
      const cleanDomain = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const steps: string[] = [];
      let team: Team | undefined;

      try {
        if (team_name) {
          const rawTeam = await client.post<Team | [Team, TeamMember]>("/teams", { name: team_name });
          team = Array.isArray(rawTeam) ? rawTeam[0] : rawTeam;
          steps.push(`team '${team.name}' created`);
        }

        const website = await client.post<Website>("/websites", {
          name: website_name,
          domain: cleanDomain,
          ...(team ? { teamId: team.id } : {}),
        });
        steps.push(`website '${website.name}' created${team ? ` under team '${team.name}'` : ""}`);
        await fetchAllWebsites(client, true);

        let replayConfig: Record<string, unknown> | undefined;
        const wantsReplayConfig =
          replay_enabled !== undefined ||
          heatmap_enabled !== undefined ||
          sample_rate !== undefined ||
          mask_level !== undefined;

        if (wantsReplayConfig) {
          const body: Record<string, unknown> = {};
          if (replay_enabled !== undefined) body.replayEnabled = replay_enabled;
          if (heatmap_enabled !== undefined) body.heatmapEnabled = heatmap_enabled;
          if (sample_rate !== undefined) body.sampleRate = sample_rate;
          if (mask_level !== undefined) body.maskLevel = mask_level;
          const updated = await client.post<Website & { replayConfig?: Record<string, unknown> }>(
            `/websites/${website.id}`,
            { replayConfig: body }
          );
          replayConfig = updated.replayConfig ?? body;
          steps.push("replay/heatmap config applied");
        }

        let grantedUser: User | undefined;
        if (grant_user_id && team) {
          const membership = await client.post<TeamMember>(`/teams/${team.id}/users`, {
            userId: grant_user_id,
            role: grant_role,
          });
          grantedUser = await client.get<User>(`/users/${membership.userId}`).catch(
            () => ({ id: membership.userId, username: membership.userId, role: membership.role }) as User
          );
          steps.push(`'${grantedUser.username}' added to team as ${grant_role}`);
        } else if (grant_user_id && !team) {
          steps.push(
            "grant_user_id was ignored because no team_name was given; there is no team to add them to"
          );
        }

        const output = {
          website: { id: website.id, name: website.name, domain: website.domain },
          team: team ? { id: team.id, name: team.name, access_code: team.accessCode } : null,
          granted_user: grantedUser
            ? { id: grantedUser.id, username: grantedUser.username, role: grant_role }
            : null,
          replay_config: replayConfig ?? null,
          tracking_snippet: `<script defer src="{your-umami-instance}/script.js" data-website-id="${website.id}"></script>`,
        };

        return textResult(
          `Onboarded **${website.name}**: ${steps.join(", ")}.\n\n` +
            `Add this to the site's <head>, replacing {your-umami-instance} with your Umami URL:\n\n` +
            `\`\`\`html\n${output.tracking_snippet}\n\`\`\`\n\n${toJson(output)}`
        );
      } catch (error) {
        const progress = steps.length
          ? `Partial progress before the error: ${steps.join(", ")}. Check umami_list_websites and umami_list_teams to see what was actually created before deciding whether to retry or clean up.\n\n`
          : "";
        return errorResult(`${progress}${errorMessage(error)}`);
      }
    }
  );
}
