/**
 * Smoke test. Stands up a fake Umami API, points the MCP server at it over stdio,
 * then lists tools and exercises the main call paths.
 */
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const WEBSITE_ID = "11111111-2222-3333-4444-555555555555";

const routes = {
  "/api/websites": () => ({
    data: [
      {
        id: WEBSITE_ID,
        name: "Leslie Hanson Real Estate",
        domain: "lesliehansonrealestate.com",
        shareId: null,
        resetAt: null,
        createdAt: "2026-01-15T00:00:00.000Z",
        teamId: null,
      },
    ],
    count: 1,
    page: 1,
    pageSize: 100,
  }),
  [`/api/websites/${WEBSITE_ID}`]: () => ({
    id: WEBSITE_ID,
    name: "Leslie Hanson Real Estate",
    domain: "lesliehansonrealestate.com",
    shareId: null,
    resetAt: null,
    createdAt: "2026-01-15T00:00:00.000Z",
  }),
  [`/api/websites/${WEBSITE_ID}/daterange`]: () => ({
    startDate: "2026-01-15T00:00:00Z",
    endDate: "2026-08-18T00:00:00Z",
  }),
  [`/api/websites/${WEBSITE_ID}/active`]: () => ({ visitors: 3 }),
  [`/api/websites/${WEBSITE_ID}/stats`]: (url) => {
    const startAt = Number(url.searchParams.get("startAt"));
    // Return a smaller number for the older comparison window.
    const older = startAt < Date.now() - 8 * 86400000;
    return older
      ? { pageviews: 800, visitors: 300, visits: 350, bounces: 180, totaltime: 42000 }
      : { pageviews: 1200, visitors: 460, visits: 520, bounces: 210, totaltime: 68000 };
  },
  [`/api/websites/${WEBSITE_ID}/pageviews`]: () => ({
    pageviews: [
      { x: "2026-08-16T00:00:00Z", y: 410 },
      { x: "2026-08-17T00:00:00Z", y: 505 },
      { x: "2026-08-18T00:00:00Z", y: 285 },
    ],
    sessions: [
      { x: "2026-08-16T00:00:00Z", y: 170 },
      { x: "2026-08-17T00:00:00Z", y: 210 },
      { x: "2026-08-18T00:00:00Z", y: 140 },
    ],
  }),
  [`/api/websites/${WEBSITE_ID}/metrics`]: (url) => {
    const type = url.searchParams.get("type");
    if (type === "path") {
      return [
        { x: "/", y: 240 },
        { x: "/listings", y: 120 },
        { x: "/contact", y: 44 },
      ];
    }
    return [
      { x: `${type}-a`, y: 90 },
      { x: `${type}-b`, y: 30 },
    ];
  },
  [`/api/websites/${WEBSITE_ID}/metrics/expanded`]: () => [
    { name: "/listings", pageviews: 400, visitors: 220, visits: 260, bounces: 190, totaltime: 9100 },
    { name: "/", pageviews: 900, visitors: 460, visits: 520, bounces: 150, totaltime: 33000 },
  ],
  [`/api/websites/${WEBSITE_ID}/events/series`]: () => [
    { x: "contact-form-submit", t: "2026-08-17T00:00:00Z", y: 6 },
    { x: "call-click", t: "2026-08-17T00:00:00Z", y: 14 },
    { x: "call-click", t: "2026-08-18T00:00:00Z", y: 9 },
  ],
  [`/api/websites/${WEBSITE_ID}/sessions`]: () => ({
    data: [
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        websiteId: WEBSITE_ID,
        hostname: "lesliehansonrealestate.com",
        browser: "chrome",
        os: "iOS",
        device: "mobile",
        country: "US",
        region: "US-FL",
        city: "Stuart",
        firstAt: "2026-08-17T14:00:00Z",
        lastAt: "2026-08-17T14:12:00Z",
        visits: 1,
        views: 7,
      },
    ],
    count: 1,
    page: 1,
    pageSize: 20,
  }),
  [`/api/websites/${WEBSITE_ID}/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`]: () => ({
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    websiteId: WEBSITE_ID,
    browser: "chrome",
    os: "iOS",
    device: "mobile",
    country: "US",
    city: "Stuart",
    firstAt: "2026-08-17T14:00:00Z",
    lastAt: "2026-08-17T14:12:00Z",
    visits: 1,
    views: 7,
    events: 2,
    totaltime: 720,
  }),
  [`/api/websites/${WEBSITE_ID}/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/activity`]: () => [
    {
      createdAt: "2026-08-17T14:00:00Z",
      urlPath: "/",
      urlQuery: "",
      referrerDomain: "google.com",
      eventId: "x",
      eventType: 1,
      eventName: "",
      visitId: "v",
      hasData: 0,
    },
  ],
  "/api/me": () => ({ id: "user-1", username: "travis", isAdmin: true }),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const handler = routes[url.pathname];
  res.setHeader("Content-Type", "application/json");
  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found", path: url.pathname }));
    return;
  }
  if (req.headers.authorization !== "Bearer test-key") {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  res.end(JSON.stringify(handler(url)));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    UMAMI_BASE_URL: `http://127.0.0.1:${port}`,
    UMAMI_API_KEY: "test-key",
    UMAMI_TIMEZONE: "America/New_York",
    UMAMI_DEFAULT_WEBSITE: "lesliehansonrealestate.com",
  },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`Tools registered: ${tools.length}`);
for (const tool of tools) {
  console.log(`  - ${tool.name}: ${Object.keys(tool.inputSchema.properties ?? {}).join(", ")}`);
}

let failures = 0;

async function check(label, name, args, expectations = [], expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((part) => part.text).join("\n");
  const missing = expectations.filter((needle) => !text.includes(needle));
  const errorMismatch = Boolean(result.isError) !== expectError;
  const failed = errorMismatch || missing.length > 0;
  if (failed) failures += 1;
  console.log(`\n${failed ? "FAIL" : "ok  "} ${label}`);
  if (failed) {
    console.log(`  missing: ${missing.join(" | ")}`);
    console.log(text.slice(0, 700));
  } else {
    console.log(text.split("\n").slice(0, 8).join("\n"));
  }
}

await check("list websites", "umami_list_websites", {}, ["Leslie Hanson", WEBSITE_ID]);
await check("website details", "umami_get_website", {}, ["Active visitors right now**: 3", "2026-01-15"]);
await check("stats with comparison", "umami_get_stats", { range: "7d" }, ["Pageviews", "1,200", "+50.0%"]);
await check("stats named range", "umami_get_stats", { range: "last_month", compare: false }, ["Bounce rate"]);
await check("explicit dates", "umami_get_stats", { start_date: "2026-07-01", end_date: "2026-07-31" }, ["Range"]);
await check("pageview series", "umami_get_pageviews_series", { range: "3d" }, ["Peak bucket", "505"]);
await check("top pages", "umami_get_metrics", { type: "path", range: "30d" }, ["/listings", "Share of shown"]);
await check("expanded metrics", "umami_get_metrics", { type: "entry", expanded: true }, ["Bounce rate", "73.1%"]);
await check("events", "umami_get_events_series", { range: "7d" }, ["call-click", "23"]);
await check("sessions", "umami_list_sessions", { range: "7d" }, ["Stuart, US", "mobile / chrome"]);
await check(
  "session detail",
  "umami_get_session",
  { session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ["Time on site**: 12m 0s", "Activity trail"]
);
await check("traffic report", "umami_traffic_report", { range: "30d" }, ["Top pages", "Acquisition channels", "Summary"]);
await check("raw get", "umami_api_get", { path: "/me" }, ["travis"]);
await check("json format", "umami_get_stats", { range: "7d", response_format: "json" }, ['"bounce_rate_pct"']);
await check("filters passthrough", "umami_get_stats", { range: "7d", filters: { country: "US" } }, ["country=US"]);

// Error paths
await check("unknown website", "umami_get_stats", { website: "nope.com" }, ["No website matched"], true);
await check("bad range", "umami_get_stats", { range: "banana" }, ["Unrecognized range"], true);
await check("raw get rejects query string", "umami_api_get", { path: "/me?x=1" }, ["must not contain a query string"], true);
await check("raw get 404", "umami_api_get", { path: "/does-not-exist" }, ["Not found"], true);
await check("bad api key", "umami_api_get", { path: "/me", params: {} }, ["travis"]);

await client.close();
server.close();

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
