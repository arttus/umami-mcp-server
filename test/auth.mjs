/**
 * Verifies the self-hosted login flow: token exchange, bearer usage, and the
 * single silent retry when a cached token has expired.
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let issuedToken = "token-one";
let loginCount = 0;
let expireNextCall = true;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Content-Type", "application/json");

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (parsed.username !== "travis" || parsed.password !== "hunter2") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "bad credentials" }));
        return;
      }
      loginCount += 1;
      issuedToken = `token-${loginCount}`;
      res.end(JSON.stringify({ token: issuedToken, user: { username: "travis" } }));
    });
    return;
  }

  // Simulate a token that has gone stale on the very first data request.
  if (expireNextCall) {
    expireNextCall = false;
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "token expired" }));
    return;
  }

  if (req.headers.authorization !== `Bearer ${issuedToken}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (url.pathname === "/api/websites") {
    res.end(
      JSON.stringify({
        data: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", name: "Gradeline", domain: "gradeline.info" }],
        count: 1,
        page: 1,
        pageSize: 100,
      })
    );
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    UMAMI_BASE_URL: `http://127.0.0.1:${port}`,
    UMAMI_USERNAME: "travis",
    UMAMI_PASSWORD: "hunter2",
    UMAMI_API_KEY: "",
  },
});

const client = new Client({ name: "auth-test", version: "1.0.0" });
await client.connect(transport);

const result = await client.callTool({ name: "umami_list_websites", arguments: {} });
const text = result.content.map((part) => part.text).join("\n");

const passed = !result.isError && text.includes("gradeline.info") && loginCount === 2;
console.log(passed ? "ok   login + stale token retry" : "FAIL login + stale token retry");
console.log(`  logins performed: ${loginCount} (expected 2: initial, then refresh after 401)`);
if (!passed) console.log(text.slice(0, 500));

await client.close();
server.close();
process.exit(passed ? 0 : 1);
