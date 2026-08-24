import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UmamiClient, errorMessage } from "../services/client.js";
import { ResponseFormat, errorResult, markdownTable, textResult, toJson } from "../format.js";
import { confirmField, responseFormatField } from "../schemas.js";
import { USER_ROLES } from "../constants.js";
import type { Paged, User, Website, Team } from "../types.js";

export function registerAdminUserTools(server: McpServer, client: UmamiClient): void {
  server.registerTool(
    "umami_create_user",
    {
      title: "Create an Umami login",
      description: `Create a new login account on this self-hosted Umami instance. This is for internal team members who need their own login, not for issuing client-facing accounts.

Admin access required. Not available on Umami Cloud.

Args:
  - username (string, required): Login username.
  - password (string, required): Login password. The user can change it after logging in.
  - role ('admin' | 'user' | 'view-only'): Instance-wide role (default: 'user'). 'admin' can manage all users and websites; 'user' can manage their own websites; 'view-only' can only view.
  - id (string, optional): Force a specific UUID for the user.

Returns:
  { "id": string, "username": string, "role": string }

Examples:
  - "Create a login for the new ops hire" -> username="jordan", password="<temp password>", role="user"

Error handling:
  - Fails with a 400 if the username is already taken.
  - Fails with 403 if the calling account is not an Umami admin.`,
      inputSchema: {
        username: z.string().min(1).max(100).describe("Login username."),
        password: z.string().min(8).max(200).describe("Login password, at least 8 characters."),
        role: z.enum(USER_ROLES).default("user").describe("Instance-wide role."),
        id: z.string().optional().describe("Force a specific UUID for the user."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ username, password, role, id }) => {
      try {
        client.requireSelfHosted("Creating users");
        const user = await client.post<User>("/users", {
          username,
          password,
          role,
          ...(id ? { id } : {}),
        });
        return textResult(
          `Created user **${user.username}** (${user.role}).\n\n${toJson({
            id: user.id,
            username: user.username,
            role: user.role,
          })}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_list_users",
    {
      title: "List all Umami users",
      description: `List every login account on this self-hosted Umami instance.

Admin access required. Not available on Umami Cloud.

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "count": number, "users": [ { "id": string, "username": string, "role": string, "created_at": string } ] }

Examples:
  - "Who has a login to our Umami?" -> no arguments`,
      inputSchema: {
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ response_format }) => {
      try {
        client.requireSelfHosted("Listing users");
        const raw = await client.get<User[]>("/admin/users");
        const users = Array.isArray(raw) ? raw : [];

        if (users.length === 0) return textResult("No users found.");

        const output = {
          count: users.length,
          users: users.map((user) => ({
            id: user.id,
            username: user.username,
            role: user.role,
            created_at: user.createdAt ?? null,
          })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const table = markdownTable(
          ["Username", "Role", "ID"],
          output.users.map((user) => [user.username, user.role, user.id])
        );
        return textResult(`# Umami users (${users.length})\n\n${table}`);
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_get_user",
    {
      title: "Get an Umami user's details",
      description: `Get a login account's details, plus the websites and teams it has access to.

Admin access required for other users; any authenticated user can look up themselves. Not available on Umami Cloud.

Args:
  - user_id (string, required): User UUID. Get this from umami_list_users.
  - response_format ('markdown' | 'json'): Output format (default: 'markdown').

Returns:
  JSON shape: { "id": string, "username": string, "role": string, "created_at": string, "websites": [ { "id": string, "name": string, "domain": string } ], "teams": [ { "id": string, "name": string } ] }`,
      inputSchema: {
        user_id: z.string().min(1).describe("User UUID."),
        response_format: responseFormatField,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ user_id, response_format }) => {
      try {
        client.requireSelfHosted("Looking up users");
        const [user, websites, teams] = await Promise.all([
          client.get<User>(`/users/${user_id}`),
          client
            .get<Paged<Website>>(`/users/${user_id}/websites`, { includeTeams: true })
            .catch(() => ({ data: [] as Website[], count: 0, page: 1, pageSize: 20 })),
          client
            .get<Paged<Team>>(`/users/${user_id}/teams`)
            .catch(() => ({ data: [] as Team[], count: 0, page: 1, pageSize: 20 })),
        ]);

        const output = {
          id: user.id,
          username: user.username,
          role: user.role,
          created_at: user.createdAt ?? null,
          websites: (websites.data ?? []).map((site) => ({
            id: site.id,
            name: site.name,
            domain: site.domain,
          })),
          teams: (teams.data ?? []).map((team) => ({ id: team.id, name: team.name })),
        };

        if (response_format === ResponseFormat.JSON) return textResult(toJson(output));

        const lines = [
          `# ${output.username}`,
          "",
          `- **Role**: ${output.role}`,
          `- **Created**: ${output.created_at ?? "unknown"}`,
          `- **Websites**: ${
            output.websites.length
              ? output.websites.map((site) => `${site.name} (${site.domain})`).join(", ")
              : "none"
          }`,
          `- **Teams**: ${output.teams.length ? output.teams.map((team) => team.name).join(", ") : "none"}`,
        ];
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_update_user",
    {
      title: "Update an Umami user",
      description: `Change a login account's username, password, or instance-wide role.

Admin access required. Not available on Umami Cloud.

Args:
  - user_id (string, required): User UUID.
  - username (string, optional): New username.
  - password (string, optional): New password.
  - role ('admin' | 'user' | 'view-only', optional): New instance-wide role.

Returns:
  { "id": string, "username": string, "role": string }

Examples:
  - "Promote jordan to admin" -> user_id="...", role="admin"
  - "Reset their password" -> user_id="...", password="<new temp password>"`,
      inputSchema: {
        user_id: z.string().min(1).describe("User UUID."),
        username: z.string().min(1).max(100).optional().describe("New username."),
        password: z.string().min(8).max(200).optional().describe("New password."),
        role: z.enum(USER_ROLES).optional().describe("New instance-wide role."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ user_id, username, password, role }) => {
      try {
        client.requireSelfHosted("Updating users");
        if (username === undefined && password === undefined && role === undefined) {
          return errorResult("Error: nothing to update. Pass at least one of username, password, or role.");
        }
        const updated = await client.post<User>(`/users/${user_id}`, {
          ...(username !== undefined ? { username } : {}),
          ...(password !== undefined ? { password } : {}),
          ...(role !== undefined ? { role } : {}),
        });
        return textResult(
          `Updated **${updated.username}** (${updated.role}).\n\n${toJson({
            id: updated.id,
            username: updated.username,
            role: updated.role,
          })}`
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );

  server.registerTool(
    "umami_delete_user",
    {
      title: "Delete an Umami user",
      description: `Permanently delete a login account from this self-hosted Umami instance. The websites they own are not deleted, but become inaccessible to them.

This cannot be undone. Requires confirm=true. Admin access required. Not available on Umami Cloud.

Args:
  - user_id (string, required): User UUID.
  - confirm (boolean, required): Must be true. There is no undo.

Returns:
  { "ok": true, "user_id": string }`,
      inputSchema: {
        user_id: z.string().min(1).describe("User UUID."),
        confirm: confirmField,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ user_id, confirm }) => {
      try {
        client.requireSelfHosted("Deleting users");
        if (confirm !== true) {
          return errorResult("Error: confirm must be true. This permanently deletes the login.");
        }
        await client.delete(`/users/${user_id}`);
        return textResult(toJson({ ok: true, user_id }));
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    }
  );
}
