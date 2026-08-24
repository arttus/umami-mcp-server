import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { ResponseFormat, errorResult, markdownTable, textResult, toJson } from "../format.js";
import { confirmField, limitField, offsetField, responseFormatField } from "../schemas.js";
import { TEAM_MEMBER_ROLES } from "../constants.js";
import type { Paged, Team, TeamMember, Website } from "../types.js";

export function registerAdminTeamTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_create_team",
    {
      title: "Create a team",
      description: `Create a team in Umami. Teams group websites and members under shared access, separate from personal accounts. Useful for keeping one client's or one product line's websites together with a dedicated access code.

Args:
  - name (string, required): Team name.

Returns:
  { "id": string, "name": string, "access_code": string }

The access_code can be shared with someone else so they can self-join via umami_join_team, instead of you adding them one by one.

Examples:
  - "Create a team to hold all the Gradeline sites" -> name="Gradeline"`,
      inputSchema: {
        name: z.string().min(1).max(200).describe("Team name."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name }) => {
      try {
        const raw = await client.post<Team | [Team, TeamMember]>("/teams", { name });
        // Umami has returned either the team object alone or [team, ownerMembership] across versions.
        const team = Array.isArray(raw) ? raw[0] : raw;
        return textResult(
          `Created team **${team.name}**.\n\n${toJson({
            id: team.id,
            name: team.name,
            access_code: team.accessCode,
          })}\n\nShare the access code with teammates so they can join via umami_join_team.`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_list_teams",
    {
      title: "List teams",
      description: `List every team on this Umami account, with member and website counts.

Args:
  - limit (number): Rows to return, 1-500 (default: 20).
  - offset (number): Rows to skip, converted to a page number (default: 0).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "count": number, "teams": [ { "id": string, "name": string, "access_code": string, "website_count": number, "member_count": number } ] }

Examples:
  - "What teams do we have set up?" -> no arguments`,
      inputSchema: {
        limit: limitField,
        offset: offsetField,
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, offset, response_format }) => {
      try {
        const page = Math.floor(offset / limit) + 1;
        const result = await client.get<Paged<Team>>("/teams", { page, pageSize: limit });
        const teams = result?.data ?? [];

        if (teams.length === 0) return textResult("No teams found.");

        const output = {
          count: result?.count ?? teams.length,
          teams: teams.map((team) => ({
            id: team.id,
            name: team.name,
            access_code: team.accessCode,
            website_count: team._count?.websites ?? 0,
            member_count: team._count?.members ?? 0,
          })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const table = markdownTable(
          ["Name", "Websites", "Members", "ID"],
          output.teams.map((team) => [team.name, team.website_count, team.member_count, team.id])
        );
        return textResult(`# Teams (${output.count})\n\n${table}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_team",
    {
      title: "Get team details and members",
      description: `Get a team's details, including its full member list and roles.

Args:
  - team_id (string, required): Team UUID. Get this from umami_list_teams.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "id": string, "name": string, "access_code": string, "members": [ { "user_id": string, "username": string, "role": string } ] }`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team_id, response_format }) => {
      try {
        const team = await client.get<Team>(`/teams/${team_id}`);
        const output = {
          id: team.id,
          name: team.name,
          access_code: team.accessCode,
          members: (team.members ?? []).map((member) => ({
            user_id: member.userId,
            username: member.user?.username ?? member.userId,
            role: member.role,
          })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const lines = [
          `# ${output.name}`,
          "",
          `- **Access code**: \`${output.access_code}\``,
          "",
          "## Members",
          "",
          markdownTable(
            ["Username", "Role", "User ID"],
            output.members.map((member) => [member.username, member.role, member.user_id])
          ),
        ];
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_team_websites",
    {
      title: "List a team's websites",
      description: `List every website belonging to a team.

Args:
  - team_id (string, required): Team UUID.
  - search (string, optional): Case-insensitive substring to filter by name or domain.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "count": number, "websites": [ { "id": string, "name": string, "domain": string } ] }`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        search: z.string().optional().describe("Case-insensitive substring to filter by name or domain."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team_id, search, response_format }) => {
      try {
        const result = await client.get<Paged<Website>>(`/teams/${team_id}/websites`, {
          ...(search ? { search } : {}),
          pageSize: 100,
        });
        const websites = result?.data ?? [];
        if (websites.length === 0) return textResult("This team has no websites.");

        const output = {
          count: result?.count ?? websites.length,
          websites: websites.map((site) => ({ id: site.id, name: site.name, domain: site.domain })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const table = markdownTable(
          ["Name", "Domain", "ID"],
          output.websites.map((site) => [site.name, site.domain, site.id])
        );
        return textResult(`# Team websites (${output.count})\n\n${table}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_update_team",
    {
      title: "Rename a team or rotate its access code",
      description: `Update a team's name, or set a new access code.

Args:
  - team_id (string, required): Team UUID.
  - name (string, optional): New team name.
  - access_code (string, optional): New access code for self-join links. Rotating it invalidates the old code.

Returns:
  { "id": string, "name": string, "access_code": string }`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        name: z.string().min(1).max(200).optional().describe("New team name."),
        access_code: z.string().min(1).optional().describe("New access code. Invalidates the old one."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team_id, name, access_code }) => {
      try {
        if (name === undefined && access_code === undefined) {
          return errorResult("Error: nothing to update. Pass 'name' and/or 'access_code'.");
        }
        const updated = await client.post<Team>(`/teams/${team_id}`, {
          ...(name !== undefined ? { name } : {}),
          ...(access_code !== undefined ? { accessCode: access_code } : {}),
        });
        return textResult(
          `Updated team **${updated.name}**.\n\n${toJson({
            id: updated.id,
            name: updated.name,
            access_code: updated.accessCode,
          })}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_join_team",
    {
      title: "Join a team via access code",
      description: `Join a team as the currently authenticated user, using its access code. This is the self-serve counterpart to umami_add_team_user, which an existing team manager uses to add someone else directly.

Args:
  - access_code (string, required): The team's access code, from umami_create_team or umami_get_team.

Returns:
  { "team_id": string, "user_id": string, "role": string }`,
      inputSchema: {
        access_code: z.string().min(1).describe("The team's access code."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ access_code }) => {
      try {
        const membership = await client.post<TeamMember>("/teams/join", { accessCode: access_code });
        return textResult(
          toJson({ team_id: membership.teamId, user_id: membership.userId, role: membership.role })
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_add_team_user",
    {
      title: "Add a user to a team",
      description: `Add an existing Umami login to a team directly, without needing the access code. Requires team-manager or owner permission on the team.

Args:
  - team_id (string, required): Team UUID.
  - user_id (string, required): User UUID to add. Get this from umami_list_users.
  - role ('team-manager' | 'team-member' | 'team-view-only'): Role within the team (default: 'team-member').

Returns:
  { "team_id": string, "user_id": string, "role": string }

Examples:
  - "Add jordan to the Gradeline team as a manager" -> team_id="...", user_id="...", role="team-manager"`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        user_id: z.string().min(1).describe("User UUID to add."),
        role: z.enum(TEAM_MEMBER_ROLES).default("team-member").describe("Role within the team."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ team_id, user_id, role }) => {
      try {
        const membership = await client.post<TeamMember>(`/teams/${team_id}/users`, {
          userId: user_id,
          role,
        });
        return textResult(
          toJson({ team_id: membership.teamId, user_id: membership.userId, role: membership.role })
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_update_team_user",
    {
      title: "Change a team member's role",
      description: `Change an existing team member's role.

Args:
  - team_id (string, required): Team UUID.
  - user_id (string, required): User UUID whose role should change.
  - role ('team-manager' | 'team-member' | 'team-view-only', required): New role.

Returns:
  { "team_id": string, "user_id": string, "role": string }`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        user_id: z.string().min(1).describe("User UUID whose role should change."),
        role: z.enum(TEAM_MEMBER_ROLES).describe("New role within the team."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team_id, user_id, role }) => {
      try {
        const membership = await client.post<TeamMember>(`/teams/${team_id}/users/${user_id}`, { role });
        return textResult(
          toJson({ team_id: membership.teamId, user_id: membership.userId, role: membership.role })
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_remove_team_user",
    {
      title: "Remove a user from a team",
      description: `Remove a member from a team. Their login and any websites they personally own are unaffected; they simply lose access to the team's shared websites.

Requires confirm=true.

Args:
  - team_id (string, required): Team UUID.
  - user_id (string, required): User UUID to remove.
  - confirm (boolean, required): Must be true.

Returns:
  { "ok": true, "team_id": string, "user_id": string }`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        user_id: z.string().min(1).describe("User UUID to remove."),
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team_id, user_id, confirm }) => {
      try {
        if (confirm !== true) {
          return errorResult("Error: confirm must be true. This removes the user's access to the team.");
        }
        await client.delete(`/teams/${team_id}/users/${user_id}`);
        return textResult(toJson({ ok: true, team_id, user_id }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_delete_team",
    {
      title: "Delete a team",
      description: `Permanently delete a team. Websites owned by the team are not deleted, but become inaccessible through it; reassign them first if they still need a home.

This cannot be undone. Requires confirm=true.

Args:
  - team_id (string, required): Team UUID.
  - confirm (boolean, required): Must be true. There is no undo.

Returns:
  { "ok": true, "team_id": string }`,
      inputSchema: {
        team_id: z.string().min(1).describe("Team UUID."),
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team_id, confirm }) => {
      try {
        if (confirm !== true) {
          return errorResult("Error: confirm must be true. This permanently deletes the team.");
        }
        await client.delete(`/teams/${team_id}`);
        return textResult(toJson({ ok: true, team_id }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
