/**
 * Exercises the write/admin tool surface: website CRUD, user CRUD, team CRUD
 * and membership, and the composite onboarding tool. Also checks that
 * destructive tools refuse to run without confirm=true.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const db = {
  websites: new Map(),
  users: new Map([["admin-1", { id: "admin-1", username: "admin", role: "admin", createdAt: "2026-01-01T00:00:00Z" }]]),
  teams: new Map(),
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.replace(/^\/api\//, "").split("/");

  if (req.headers.authorization !== "Bearer test-key") return json(res, 401, { error: "unauthorized" });

  try {
    // /websites
    if (parts[0] === "websites" && parts.length === 1 && req.method === "POST") {
      const body = await readBody(req);
      const id = body.id || randomUUID();
      const site = {
        id,
        name: body.name,
        domain: body.domain,
        shareId: null,
        teamId: body.teamId ?? null,
        createdAt: new Date().toISOString(),
      };
      db.websites.set(id, site);
      return json(res, 200, site);
    }
    if (parts[0] === "websites" && parts.length === 1 && req.method === "GET") {
      const data = [...db.websites.values()];
      return json(res, 200, { data, count: data.length, page: 1, pageSize: 100 });
    }
    if (parts[0] === "websites" && parts[2] === "recorder" && req.method === "GET") {
      const site = db.websites.get(parts[1]);
      if (!site || !site.replayConfig) return json(res, 200, { enabled: false });
      return json(res, 200, { enabled: true, ...site.replayConfig });
    }
    if (parts[0] === "websites" && parts.length === 2 && req.method === "POST") {
      const site = db.websites.get(parts[1]);
      if (!site) return json(res, 404, { error: "not found" });
      const body = await readBody(req);
      Object.assign(site, body.name !== undefined ? { name: body.name } : {});
      Object.assign(site, body.domain !== undefined ? { domain: body.domain } : {});
      if (body.shareId !== undefined) site.shareId = body.shareId;
      if (body.replayConfig) {
        site.replayConfig = {
          replayEnabled: false,
          heatmapEnabled: false,
          sampleRate: 0,
          heatmapSampleRate: 0,
          maskLevel: "moderate",
          maxDuration: 300000,
          blockSelector: "",
          ...site.replayConfig,
          ...body.replayConfig,
        };
      }
      return json(res, 200, site);
    }
    if (parts[0] === "websites" && parts.length === 2 && req.method === "DELETE") {
      db.websites.delete(parts[1]);
      return json(res, 200, { ok: true });
    }
    if (parts[0] === "websites" && parts[2] === "reset" && req.method === "POST") {
      if (!db.websites.has(parts[1])) return json(res, 404, { error: "not found" });
      return json(res, 200, { ok: true });
    }

    // /users
    if (parts[0] === "users" && parts.length === 1 && req.method === "POST") {
      const body = await readBody(req);
      const id = body.id || randomUUID();
      const user = { id, username: body.username, role: body.role ?? "user", createdAt: new Date().toISOString() };
      db.users.set(id, user);
      return json(res, 200, user);
    }
    if (parts[0] === "admin" && parts[1] === "users" && req.method === "GET") {
      return json(res, 200, [...db.users.values()]);
    }
    if (parts[0] === "users" && parts.length === 2 && req.method === "GET") {
      const user = db.users.get(parts[1]);
      return user ? json(res, 200, user) : json(res, 404, { error: "not found" });
    }
    if (parts[0] === "users" && parts.length === 2 && req.method === "POST") {
      const user = db.users.get(parts[1]);
      if (!user) return json(res, 404, { error: "not found" });
      const body = await readBody(req);
      Object.assign(user, body);
      return json(res, 200, user);
    }
    if (parts[0] === "users" && parts.length === 2 && req.method === "DELETE") {
      db.users.delete(parts[1]);
      return json(res, 200, { ok: true });
    }
    if (parts[0] === "users" && parts[2] === "websites" && req.method === "GET") {
      return json(res, 200, { data: [], count: 0, page: 1, pageSize: 20 });
    }
    if (parts[0] === "users" && parts[2] === "teams" && req.method === "GET") {
      return json(res, 200, { data: [], count: 0, page: 1, pageSize: 20 });
    }

    // /teams
    if (parts[0] === "teams" && parts.length === 1 && req.method === "POST") {
      const body = await readBody(req);
      const id = randomUUID();
      const team = {
        id,
        name: body.name,
        accessCode: `team_${id.slice(0, 8)}`,
        members: [],
        _count: { websites: 0, members: 1 },
      };
      db.teams.set(id, team);
      return json(res, 200, team);
    }
    if (parts[0] === "teams" && parts.length === 1 && req.method === "GET") {
      const data = [...db.teams.values()];
      return json(res, 200, { data, count: data.length, page: 1, pageSize: 20 });
    }
    if (parts[0] === "teams" && parts.length === 2 && req.method === "GET") {
      const team = db.teams.get(parts[1]);
      return team ? json(res, 200, team) : json(res, 404, { error: "not found" });
    }
    if (parts[0] === "teams" && parts.length === 2 && req.method === "POST") {
      const team = db.teams.get(parts[1]);
      if (!team) return json(res, 404, { error: "not found" });
      const body = await readBody(req);
      if (body.name !== undefined) team.name = body.name;
      if (body.accessCode !== undefined) team.accessCode = body.accessCode;
      return json(res, 200, team);
    }
    if (parts[0] === "teams" && parts.length === 2 && req.method === "DELETE") {
      db.teams.delete(parts[1]);
      return json(res, 200, { ok: true });
    }
    if (parts[0] === "teams" && parts[2] === "users" && parts.length === 3 && req.method === "POST") {
      const team = db.teams.get(parts[1]);
      if (!team) return json(res, 404, { error: "not found" });
      const body = await readBody(req);
      const membership = { id: randomUUID(), teamId: team.id, userId: body.userId, role: body.role };
      team.members.push({ ...membership, user: db.users.get(body.userId) });
      team._count.members = team.members.length;
      return json(res, 200, membership);
    }
    if (parts[0] === "teams" && parts[2] === "users" && parts.length === 4 && req.method === "POST") {
      const team = db.teams.get(parts[1]);
      if (!team) return json(res, 404, { error: "not found" });
      const body = await readBody(req);
      const member = team.members.find((m) => m.userId === parts[3]);
      if (member) member.role = body.role;
      return json(res, 200, { id: member?.id, teamId: team.id, userId: parts[3], role: body.role });
    }
    if (parts[0] === "teams" && parts[2] === "users" && parts.length === 4 && req.method === "DELETE") {
      const team = db.teams.get(parts[1]);
      if (team) team.members = team.members.filter((m) => m.userId !== parts[3]);
      return json(res, 200, { ok: true });
    }
    if (parts[0] === "teams" && parts[2] === "websites" && req.method === "GET") {
      const sites = [...db.websites.values()].filter((s) => s.teamId === parts[1]);
      return json(res, 200, { data: sites, count: sites.length, page: 1, pageSize: 20 });
    }
    if (parts[0] === "teams" && parts[1] === "join" && req.method === "POST") {
      const body = await readBody(req);
      const team = [...db.teams.values()].find((t) => t.accessCode === body.accessCode);
      if (!team) return json(res, 404, { error: "not found" });
      return json(res, 200, { id: randomUUID(), teamId: team.id, userId: "admin-1", role: "team-member" });
    }

    return json(res, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, UMAMI_BASE_URL: `http://127.0.0.1:${port}`, UMAMI_API_KEY: "test-key" },
});

const client = new Client({ name: "admin-test", version: "1.0.0" });
await client.connect(transport);

let failures = 0;
let websiteId, teamId, userId;

async function check(label, name, args, expectations = [], expectError = false) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    result = { isError: true, content: [{ type: "text", text: String(err) }] };
  }
  const text = result.content.map((part) => part.text).join("\n");
  const missing = expectations.filter((needle) => !text.includes(needle));
  const errorMismatch = Boolean(result.isError) !== expectError;
  const failed = errorMismatch || missing.length > 0;
  if (failed) failures += 1;
  console.log(`${failed ? "FAIL" : "ok  "} ${label}`);
  if (failed) {
    console.log(`  missing: ${missing.join(" | ")}`);
    console.log(text.slice(0, 500));
  }
  return text;
}

function lastJson(text) {
  const start = text.lastIndexOf("\n\n{");
  let depth = 0;
  for (let i = start + 2; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start + 2, i + 1));
    }
  }
  throw new Error("No balanced JSON object found in tool output");
}

// Website CRUD
{
  const text = await check(
    "create website",
    "umami_create_website",
    { name: "Test Co", domain: "https://testco.com/" },
    ["Created website", "testco.com", "tracking_snippet"]
  );
  websiteId = lastJson(text).id;
}
await check("update website", "umami_update_website", { website: websiteId, share_id: "public-link" }, ["public-link"]);
await check(
  "update website full replay config",
  "umami_update_website",
  {
    website: websiteId,
    replay_enabled: true,
    heatmap_enabled: true,
    sample_rate: 0.2,
    heatmap_sample_rate: 0.1,
    mask_level: "strict",
    max_duration_ms: 600000,
    block_selector: ".payment-form",
  },
  ['"replayEnabled": true', '"maskLevel": "strict"', '"blockSelector": ".payment-form"']
);
await check("get recorder config reflects update", "umami_get_recorder_config", { website: websiteId }, [
  '"replay_enabled": true',
  '"mask_level": "strict"',
  '"block_selector": ".payment-form"',
]);
await check(
  "update website no-op rejected",
  "umami_update_website",
  { website: websiteId },
  ["nothing to update"],
  true
);
await check("reset without confirm rejected", "umami_reset_website", { website: websiteId }, ["confirm"], true);
await check("reset with confirm", "umami_reset_website", { website: websiteId, confirm: true }, ["ok"]);

// User CRUD
{
  const text = await check(
    "create user",
    "umami_create_user",
    { username: "jordan", password: "correct-horse-battery", role: "user" },
    ["Created user", "jordan"]
  );
  userId = lastJson(text).id;
}
await check("list users", "umami_list_users", {}, ["jordan", "admin"]);
await check("get user", "umami_get_user", { user_id: userId }, ["jordan"]);
await check("update user role", "umami_update_user", { user_id: userId, role: "admin" }, ["admin"]);

// Team CRUD + membership
{
  const text = await check("create team", "umami_create_team", { name: "Gradeline" }, ["Created team", "Gradeline", "access_code"]);
  teamId = lastJson(text).id;
}
await check("list teams", "umami_list_teams", {}, ["Gradeline"]);
await check("add user to team", "umami_add_team_user", { team_id: teamId, user_id: userId, role: "team-manager" }, ["team-manager"]);
await check("get team shows member", "umami_get_team", { team_id: teamId }, ["jordan", "team-manager"]);
await check("update team member role", "umami_update_team_user", { team_id: teamId, user_id: userId, role: "team-member" }, ["team-member"]);
await check(
  "remove team user without confirm rejected",
  "umami_remove_team_user",
  { team_id: teamId, user_id: userId },
  ["confirm"],
  true
);
await check("remove team user with confirm", "umami_remove_team_user", { team_id: teamId, user_id: userId, confirm: true }, ["ok"]);

// Composite onboarding
{
  const text = await check(
    "onboard client",
    "umami_onboard_client",
    {
      website_name: "Walker's Land Services",
      domain: "walkerslandservices.com",
      team_name: "Walker's Land Services",
      replay_enabled: true,
      sample_rate: 0.15,
    },
    ["Onboarded", "team 'Walker's Land Services' created", "website 'Walker's Land Services' created under team", "replay/heatmap config applied"]
  );
  void text;
}

// Destructive delete gating + cleanup
await check("delete website without confirm rejected", "umami_delete_website", { website: websiteId }, ["confirm"], true);
await check("delete website with confirm", "umami_delete_website", { website: websiteId, confirm: true }, ["ok"]);
await check("delete user without confirm rejected", "umami_delete_user", { user_id: userId }, ["confirm"], true);
await check("delete user with confirm", "umami_delete_user", { user_id: userId, confirm: true }, ["ok"]);
await check("delete team without confirm rejected", "umami_delete_team", { team_id: teamId }, ["confirm"], true);
await check("delete team with confirm", "umami_delete_team", { team_id: teamId, confirm: true }, ["ok"]);

await client.close();
server.close();

console.log(`\n${failures === 0 ? "All admin checks passed." : `${failures} admin check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
