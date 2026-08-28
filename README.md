# umami-mcp-server

An MCP server for [Umami Analytics](https://umami.is). Works against both Umami Cloud and self-hosted instances, and speaks in ranges like `last_month` and site names like `example.com` rather than epoch milliseconds and UUIDs.

Forty-eight tools covering website discovery, traffic stats, time series, ranked breakdowns, custom events, individual sessions, funnels, journeys, goals, retention, revenue, session replays and click heatmaps, saved reports and audience segments that show up in the Umami UI, full admin CRUD for websites/users/teams, a composite client-onboarding tool, and a raw GET escape hatch for anything else in the Umami API.

**This server is not read-only.** Most tools read, but it can also create, update, and permanently delete websites, users, teams, saved reports, and segments, and it can wipe a website's collected data. See [Write access and safety](#write-access-and-safety) before connecting it to anything you care about.

Admin tools (creating users, teams, and websites; deleting anything) require **self-hosted Umami with an admin login or admin API key**. Umami Cloud does not expose user or team management via the API, so those tools return a clear error rather than a confusing 404 if pointed at Cloud.

## What you can ask it

The Umami dashboard is a good place to look at your analytics. It is a tedious place to set them up, and a slow place to answer a question that needs three screens and a UUID. That is the gap this server fills: you describe what you want in plain language, and your agent picks the tool, resolves `example.com` to its ID, turns "last month" into timestamps in your timezone, and hands back a readable answer. Everything below is a real thing you can type.

**See how the site is doing.**

- "How did example.com do last month compared to the month before?" → `umami_get_stats` with `range=last_month`
- "Give me the full rundown for the last 30 days" → `umami_traffic_report`, stats plus seven breakdowns in one call
- "Which landing page has the worst bounce rate?" → `umami_get_metrics` with `type=entry`, `expanded=true`
- "Show me top pages for mobile visitors in Florida" → `umami_get_metrics` with `filters={ device: "mobile", region: "US-FL" }`
- "How many contact form submits this week?" → `umami_get_events_series` with `event=contact-form-submit`

**Work out why.** These are the questions a stats page cannot answer, and the ones this server computes for you even though Umami has no endpoint for them.

- "Where do people drop off between pricing and signup?" → `umami_get_funnel` with `steps=["/pricing", "/signup", "signup-complete"]`
- "What do people actually do after landing on the homepage?" → `umami_get_journeys` with `start_path="/"`
- "Where are people clicking on the pricing page?" → `umami_get_click_heatmap` with `path="/pricing"`
- "What did that one session do on the site?" → `umami_list_sessions`, then `umami_get_session` or `umami_get_replay`
- "How much revenue came from Google this month?" → `umami_get_revenue` with `event=purchase`, `property=amount`, `filters={ utmSource: "google" }`
- "Do people come back the week after they sign up?" → `umami_get_retention`, if the site calls `umami.identify()`

**Set the dashboard up by talking to it.** Answers computed on demand disappear when the conversation ends. Describe the goal, funnel, or segment you want and it is built for you in the Umami web UI, waiting there for anyone who logs in, without you filling in the forms.

- "Save that funnel so the client sees it under Behavior" → `umami_create_funnel`
- "Make a goal for the thank-you page" → `umami_create_goal`
- "Create a segment for paid mobile traffic" → `umami_create_segment`
- "What reports are already saved for this site?" → `umami_list_saved_reports`

**Run the instance.** Self-hosted, with an admin credential.

- "Set up tracking for the new client, its own team, and put jordan on it" → `umami_onboard_client`, one call for website plus team plus access
- "Give me the tracking snippet for that site" → comes back with the `<script>` tag from `umami_create_website`
- "Turn on session recording at 25 percent sampling, and mask form inputs" → `umami_update_website`, then `umami_get_recorder_config` to confirm what the tracker actually receives
- "Wipe the test data before this site goes live" → `umami_reset_website` with `confirm=true`

A useful pattern is chaining without naming any tools: "which page loses the most people, then show me a few recordings of them leaving" walks `umami_get_metrics`, then `umami_list_replays` filtered to that path, then `umami_get_replay`. Three screens and some ID copying in the UI, one sentence here.

## Install

```bash
npm install
npm run build
```

## Configure

Copy `.env.example` and fill in one of the two auth paths.

### Umami Cloud

Create a key under Settings, API keys.

| Variable | Required | Notes |
| --- | --- | --- |
| `UMAMI_API_KEY` | yes | Your Cloud API key |
| `UMAMI_REGION` | no | `us` or `eu`. Defaults to the key owner's region |

### Self-hosted

| Variable | Required | Notes |
| --- | --- | --- |
| `UMAMI_BASE_URL` | yes | Root URL of the instance, e.g. `https://analytics.example.com`. The `/api` suffix is added automatically |
| `UMAMI_API_KEY` | either | An API key on the instance |
| `UMAMI_USERNAME` + `UMAMI_PASSWORD` | either | Login credentials, exchanged for a bearer token and refreshed automatically when it expires |

### Both

| Variable | Default | Notes |
| --- | --- | --- |
| `UMAMI_TIMEZONE` | `UTC` | IANA timezone for day boundaries and time-series buckets, e.g. `America/New_York` |
| `UMAMI_DEFAULT_WEBSITE` | none | Website ID, name, or domain used when a tool call omits `website`. Set this if you mostly query one site |

## Connect it

### Claude Desktop or Claude Code

Add to `claude_desktop_config.json`, or run `claude mcp add`:

```json
{
  "mcpServers": {
    "umami": {
      "command": "node",
      "args": ["/absolute/path/to/umami-mcp-server/dist/index.js"],
      "env": {
        "UMAMI_API_KEY": "your-key",
        "UMAMI_TIMEZONE": "America/New_York",
        "UMAMI_DEFAULT_WEBSITE": "example.com"
      }
    }
  }
}
```

For a self-hosted instance, swap in `UMAMI_BASE_URL` and either the key or the username and password pair.

### MCP Inspector

```bash
UMAMI_API_KEY=your-key npm run inspect
```

## Write access and safety

The credentials you give this server are the real ceiling on what it can do. An admin key means the agent holds admin rights.

Tools that change state:

- **Create:** `umami_create_website`, `umami_create_user`, `umami_create_team`, `umami_create_goal`, `umami_create_funnel`, `umami_create_segment`, `umami_create_cohort`, `umami_onboard_client`
- **Update:** `umami_update_website`, `umami_update_user`, `umami_update_team`, `umami_update_team_user`, `umami_add_team_user`, `umami_join_team`
- **Delete or wipe:** `umami_reset_website`, `umami_delete_website`, `umami_delete_user`, `umami_delete_team`, `umami_remove_team_user`, `umami_delete_saved_report`, `umami_delete_segment_cohort`

Every tool in the delete-or-wipe group requires a literal `confirm: true` argument and fails without it. There is no second round-trip: **the tool call itself is the confirmation**, and `umami_reset_website` and `umami_delete_website` destroy collected analytics data that cannot be recovered.

To run this read-only, scope the credential rather than trusting the tool list: give it a non-admin API key, or a login whose role only grants view access to the websites it should see. Umami enforces that server-side, so the write tools fail with a permission error instead of succeeding.

If your MCP client supports per-tool permissions, a second layer is to allowlist only the `umami_get_*`, `umami_list_*`, `umami_traffic_report`, and `umami_api_get` tools, and gate or deny the rest.

## Tools

### Analytics (read-only)

| Tool | What it does |
| --- | --- |
| `umami_list_websites` | List every tracked website, with optional search. Start here when you do not know an ID |
| `umami_get_website` | Website config plus the date range of data actually collected, plus the live visitor count |
| `umami_get_active_visitors` | Unique visitors in the last 5 minutes |
| `umami_get_stats` | Pageviews, visitors, visits, bounce rate, average visit duration, with period-over-period change |
| `umami_get_pageviews_series` | Pageviews and sessions bucketed by minute, hour, day, month, or year |
| `umami_get_metrics` | Ranked breakdown by any dimension. `expanded=true` adds per-row engagement metrics |
| `umami_get_events_series` | Custom event counts over time, grouped by event name |
| `umami_list_sessions` | Paginated list of individual anonymous sessions |
| `umami_get_session` | One session plus its page-by-page activity trail |
| `umami_traffic_report` | Stats and seven breakdowns in a single call. The right tool for "how is the site doing" |

### Behavior analysis (read-only, computed here)

Umami has no endpoints for any of these. Each is derived from data Umami does expose, so they work on stock instances but cost more API calls than a plain stat. See [Design notes](#design-notes) for what that costs.

| Tool | What it does |
| --- | --- |
| `umami_get_goal` | Conversion rate toward one page or one custom event, against the same-range visitor baseline. Two filtered stats calls |
| `umami_get_funnel` | Session counts and drop-off across 2 to 8 ordered steps, each a page path or an event name. Walks session activity trails |
| `umami_get_journeys` | The most common ordered page sequences visitors take, optionally from a given entry path |
| `umami_get_retention` | Cohort retention curve by day, week, or month. Requires the site to call `umami.identify()` with a stable ID, otherwise every cohort is empty |
| `umami_get_revenue` | Total, average, and count from a numeric property on a custom event, e.g. an `amount` field on `purchase`. Filterable, so revenue by UTM source works |

### Session replay and heatmaps (read-only)

| Tool | What it does |
| --- | --- |
| `umami_list_replays` | Recorded session replays for a range, newest first. Only exist where recording is enabled and the session was sampled |
| `umami_get_replay` | Summary of one replay: pages, click count, duration and event breakdown. Optionally the raw click coordinates. Never the raw rrweb stream |
| `umami_get_click_heatmap` | Click-density grid for one page path, built by downloading replays and normalizing every click against its recording's viewport |
| `umami_get_recorder_config` | The live config Umami is actually serving to the tracker. Ground truth after `umami_update_website` |

### Saved reports and audiences (visible in the Umami UI)

Everything above computes on demand and leaves no trace in the dashboard. These persist definitions so they appear in the Umami web UI for anyone browsing it.

| Tool | What it does |
| --- | --- |
| `umami_create_goal` | Persist a Goal under Behavior, Goals |
| `umami_create_funnel` | Persist a Funnel under Behavior, Funnels |
| `umami_list_saved_reports` | List saved goals, funnels, journeys, or retention reports for a website |
| `umami_delete_saved_report` | **Destructive.** Delete a saved report. Requires `confirm=true` |
| `umami_create_segment` | Persist an audience Segment (a saved filter combination) under Audience, Segments |
| `umami_create_cohort` | Persist a Cohort (visitors who did something in a window, optionally filtered further) under Audience, Cohorts |
| `umami_list_segments_cohorts` | List saved segments or cohorts |
| `umami_delete_segment_cohort` | **Destructive.** Delete a saved segment or cohort. Requires `confirm=true` |

### Admin: websites (self-hosted, admin login or key)

| Tool | What it does |
| --- | --- |
| `umami_create_website` | Register a new website and get back its tracking ID and `<script>` snippet |
| `umami_update_website` | Rename, change domain, set a public share link, and configure every replay/heatmap field: enable flags, sample rates, PII mask level, max recording length, block selector |
| `umami_reset_website` | **Destructive.** Wipe all collected data, keep the website and tracking ID. Requires `confirm=true` |
| `umami_delete_website` | **Destructive.** Delete the website registration and all its data. Requires `confirm=true` |

### Admin: users (self-hosted, admin login or key)

| Tool | What it does |
| --- | --- |
| `umami_create_user` | Create an internal login |
| `umami_list_users` | List every login on the instance |
| `umami_get_user` | One user's role plus the websites and teams they can access |
| `umami_update_user` | Change username, password, or instance-wide role |
| `umami_delete_user` | **Destructive.** Remove a login. Requires `confirm=true` |

### Admin: teams (self-hosted, admin login or key)

| Tool | What it does |
| --- | --- |
| `umami_create_team` | Create a team and get its access code |
| `umami_list_teams` | List teams with member and website counts |
| `umami_get_team` | Team details plus full member list and roles |
| `umami_get_team_websites` | Websites belonging to a team |
| `umami_update_team` | Rename a team or rotate its access code |
| `umami_join_team` | Join a team as the authenticated user, via access code |
| `umami_add_team_user` | Add an existing login to a team directly |
| `umami_update_team_user` | Change a team member's role |
| `umami_remove_team_user` | **Destructive.** Remove a member from a team. Requires `confirm=true` |
| `umami_delete_team` | **Destructive.** Delete a team. Requires `confirm=true` |

### Provisioning

| Tool | What it does |
| --- | --- |
| `umami_onboard_client` | One call: create a website, optionally a dedicated team for it, optionally grant an existing user access, optionally set replay/heatmap config from the start. The fast path for setting up a new client |

### Escape hatch

| Tool | What it does |
| --- | --- |
| `umami_api_get` | Read-only GET against any Umami endpoint without a dedicated tool. Cannot create, modify, reset, or delete anything |

Every data tool takes `response_format`: `markdown` for a readable summary, `json` for the structured payload.

### Date ranges

Pass `range` as any of:

- Relative: `30m`, `24h`, `7d`, `4w`, `3mo`, `1y`
- Named: `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`, `last_year`, `mtd`, `ytd`, `all_time`

Or pass `start_date` and `end_date` as `YYYY-MM-DD`, a full ISO 8601 timestamp, or epoch milliseconds. Explicit dates override `range`. Day boundaries respect `UMAMI_TIMEZONE`, or a per-call `timezone` argument.

### Filters

Most tools accept a `filters` object that segments the query:

```json
{ "country": "US", "device": "mobile", "path": "/pricing" }
```

Supported keys: `path`, `referrer`, `title`, `query`, `browser`, `os`, `device`, `country`, `region`, `city`, `language`, `hostname`, `tag`, `event`, `distinctId`, `utmSource`, `utmMedium`, `utmCampaign`, `utmContent`, `utmTerm`, `segment`, `cohort`.

### Breakdown dimensions

For `umami_get_metrics` and the `breakdowns` argument of `umami_traffic_report`: `path`, `entry`, `exit`, `title`, `query`, `referrer`, `channel`, `domain`, `country`, `region`, `city`, `browser`, `os`, `device`, `language`, `screen`, `event`, `hostname`, `tag`, `distinctId`, plus the five `utm*` dimensions.

## Design notes

- **Website resolution.** Any tool's `website` argument accepts a UUID, a name, or a domain. Names and domains are matched against a 60-second cached website list, with an explicit ambiguity error rather than a silent wrong guess. Creating, updating, or deleting a website refreshes that cache immediately.
- **Undocumented endpoints, marked as such.** Saved goals, funnels, journeys, and retention reports live on `POST/GET/DELETE /reports`; segments and cohorts live on a separate `/websites/:id/segments`. Neither is in Umami's published REST API. Both were mapped by watching the web UI's own network calls, and the exact request shapes are documented in comments at the top of `src/tools/saved-reports.ts` and `src/tools/segments.ts`, including which enum values a 400 response confirmed. These can change without notice on a future Umami version, unlike the documented analytics endpoints.
- **Derived analytics cost API calls.** Funnels and journeys have no endpoint, so both walk session activity trails: one `/sessions` page plus one `/sessions/:id/activity` call per session, capped by `max_sessions` (default 500, max 2000) and reported back as `truncated` when the range held more. The click heatmap downloads up to `max_replays` recordings (default 100). Umami Cloud rate-limits to 50 calls per 15 seconds, and the client surfaces that as a plain message rather than a raw 429. Raise the caps deliberately.
- **Retention needs instrumentation, not just traffic.** `umami_get_retention` is built from `distinctId`, which only exists where the site calls `umami.identify(persistentId)`. Without it, cohort size is 0 no matter how much real traffic there is, and the tool says so instead of reporting a broken curve.
- **Computed versus saved.** `umami_get_goal` and `umami_get_funnel` compute on demand and leave nothing in the dashboard. `umami_create_goal` and `umami_create_funnel` persist a definition that shows up in the Umami UI. Two different jobs, deliberately two different tools.
- **Full replay/heatmap config, not just toggles.** `umami_update_website` exposes every field Umami's `replayConfig` accepts: enable flags, independent sample rates for replay vs. heatmaps, PII mask level, block selector, and max recording duration. Umami's own docs give inconsistent units for `maxDuration` (one example implies milliseconds, another implies seconds); rather than guess, `umami_get_recorder_config` reads the same public endpoint the tracker itself calls, so you can confirm the effective value after saving instead of trusting either doc example.
- **Replays are summarized, never dumped.** `umami_get_replay` returns pages, click count, and a duration breakdown. The raw rrweb event stream can run to tens of thousands of events and would blow any context window.
- **Derived metrics.** Umami returns raw `bounces` and `totaltime` counts. Bounce rate, views per visit, and average visit duration are computed here so every response is directly readable.
- **Partial failure.** `umami_traffic_report` runs its breakdowns in parallel and drops any dimension the instance does not support, naming the skipped ones instead of failing the whole report. This matters because dimension support varies across Umami versions.
- **Destructive ops are opt-in, not confirmed twice.** Every reset, delete, and remove tool requires a literal `confirm: true` argument and fails otherwise. There is no separate "are you sure" round-trip: the tool call itself is the confirmation, so an agent (or a person) should only pass `confirm: true` once they mean it.
- **`umami_onboard_client` is best-effort, not transactional.** Umami's API has no multi-step transaction support. If team creation succeeds but the website step fails, the team is left in place and the error message says so explicitly, along with what to check next, rather than silently rolling back or hiding the partial state.
- **Escape hatch stays read-only.** `umami_api_get` is deliberately GET-only, separate from the admin tools above. It cannot create, modify, reset, or delete anything.
- **Response size.** Responses are capped at 25,000 characters with a message pointing at `limit`, `offset`, or a narrower range.

## Tests

```bash
npm test
```

Three suites run against a fake Umami API over a real MCP stdio client. `test/smoke.mjs` exercises the analytics tools plus their error paths. `test/auth.mjs` covers the self-hosted login exchange and the token refresh that fires when a cached bearer token goes stale. `test/admin.mjs` covers website/user/team CRUD, team membership, the composite onboarding tool, and confirms every destructive admin tool refuses to run without `confirm=true`.

Coverage is the core analytics and admin surface. The behavior-analysis, replay, saved-report, and segment tools are not yet in the suites and have been verified by hand against a live self-hosted instance.

## Verified against

Umami v3 API as of August 2026.

Documented endpoints: `/websites`, `/websites/:id`, `/websites/:id/stats`, `/pageviews`, `/metrics`, `/metrics/expanded`, `/events/series`, `/active`, `/daterange`, `/sessions`, `/sessions/:id`, `/sessions/:id/activity`, `/websites/:id/reset`, `/websites/:id/event-data/values`, `/users`, `/admin/users`, `/users/:id`, `/users/:id/websites`, `/users/:id/teams`, `/teams`, `/teams/join`, `/teams/:id`, `/teams/:id/users`, `/teams/:id/users/:userId`, `/teams/:id/websites`.

Undocumented endpoints, mapped from the web UI: `/reports` (saved goals, funnels, journeys, retention), `/websites/:id/segments` (segments and cohorts), `/websites/:id/replays`, `/websites/:id/replays/:id`.

Cloud requests go to `https://api.umami.is/v1` with a bearer token; self-hosted requests go to `{base}/api`. User and team management endpoints only exist on self-hosted instances.

## License

MIT
