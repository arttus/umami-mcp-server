# umami-mcp-server

An MCP server for [Umami Analytics](https://umami.is). Read-only, works against both Umami Cloud and self-hosted instances, and speaks in ranges like `last_month` and site names like `example.com` rather than epoch milliseconds and UUIDs.

Twenty-five tools covering website discovery, traffic stats, time series, ranked breakdowns, custom events, individual sessions, a one-call full report, full admin CRUD for websites/users/teams, a composite client-onboarding tool, and a raw GET escape hatch for anything else in the Umami API.

Admin tools (creating users, teams, and websites; deleting anything) require **self-hosted Umami with an admin login or admin API key**. Umami Cloud does not expose user or team management via the API, so those tools return a clear error rather than a confusing 404 if pointed at Cloud.

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

### Admin: websites (self-hosted, admin login or key)

| Tool | What it does |
| --- | --- |
| `umami_create_website` | Register a new website and get back its tracking ID and `<script>` snippet |
| `umami_update_website` | Rename, change domain, set a public share link, and configure every replay/heatmap field: enable flags, sample rates, PII mask level, max recording length, block selector |
| `umami_get_recorder_config` | Read the live config Umami is actually serving to the tracker for a website. Ground truth after `umami_update_website`, since the same field appears in different units across Umami's own docs |
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
| `umami_api_get` | Read-only GET against any Umami endpoint without a dedicated tool |

Every data tool takes `response_format`: `markdown` for a readable summary, `json` for the structured payload. Every destructive tool (`reset`, `delete`, `remove`) takes a required `confirm: true` argument; the call is rejected without it, and there is no other confirmation step, so treat that argument as the point of no return.

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

For `umami_get_metrics` and the `breakdowns` argument of `umami_traffic_report`: `path`, `entry`, `exit`, `title`, `query`, `referrer`, `channel`, `domain`, `country`, `region`, `city`, `browser`, `os`, `device`, `language`, `screen`, `event`, `hostname`, `tag`, `distinctId`.

## Examples

Ask naturally once it is connected:

- "How did the site do last month compared to the month before?" → `umami_get_stats` with `range=last_month`
- "Give me the full analytics rundown for the last 30 days" → `umami_traffic_report`
- "Which landing page has the worst bounce rate?" → `umami_get_metrics` with `type=entry`, `expanded=true`
- "How many contact form submits this week?" → `umami_get_events_series` with `event=contact-form-submit`
- "Show me top pages for mobile visitors in Florida" → `umami_get_metrics` with `type=path`, `filters={ device: "mobile", region: "US-FL" }`
- "What did that session actually do on the site?" → `umami_list_sessions`, then `umami_get_session`
- "Set up tracking for the new client, its own team, and put jordan on it" → `umami_onboard_client` with `website_name`, `domain`, `team_name`, `grant_user_id`
- "Wipe the test data before this site goes live" → `umami_reset_website` with `confirm=true`

## Design notes

- **Website resolution.** Any tool's `website` argument accepts a UUID, a name, or a domain. Names and domains are matched against a 60-second cached website list, with an explicit ambiguity error rather than a silent wrong guess. Creating, updating, or deleting a website refreshes that cache immediately.
- **Full replay/heatmap config, not just toggles.** `umami_update_website` exposes every field Umami's `replayConfig` accepts: enable flags, independent sample rates for replay vs. heatmaps, PII mask level, block selector, and max recording duration. Umami's own docs give inconsistent units for `maxDuration` (one example implies milliseconds, another implies seconds); rather than guess, `umami_get_recorder_config` reads the same public endpoint the tracker itself calls, so you can confirm the effective value after saving instead of trusting either doc example.
- **Derived metrics.** Umami returns raw `bounces` and `totaltime` counts. Bounce rate, views per visit, and average visit duration are computed here so every response is directly readable.
- **Partial failure.** `umami_traffic_report` runs its breakdowns in parallel and drops any dimension the instance does not support, naming the skipped ones instead of failing the whole report. This matters because dimension support varies across Umami versions.
- **Destructive ops are opt-in, not confirmed twice.** `umami_reset_website`, `umami_delete_website`, `umami_delete_user`, `umami_remove_team_user`, and `umami_delete_team` all require a literal `confirm: true` argument and fail otherwise. There is no separate "are you sure" round-trip: the tool call itself is the confirmation, so an agent (or a person) should only pass `confirm: true` once they mean it.
- **`umami_onboard_client` is best-effort, not transactional.** Umami's API has no multi-step transaction support. If team creation succeeds but the website step fails, the team is left in place and the error message says so explicitly, along with what to check next, rather than silently rolling back or hiding the partial state.
- **Escape hatch.** `umami_api_get` is deliberately GET-only, separate from the admin tools above. It cannot create, modify, reset, or delete anything.
- **Response size.** Responses are capped at 25,000 characters with a message pointing at `limit`, `offset`, or a narrower range.

## Tests

```bash
npm test
```

`test/smoke.mjs` stands up a fake Umami API, connects a real MCP client over stdio, and exercises the analytics tools plus their error paths. `test/auth.mjs` covers the self-hosted login exchange and the token refresh that fires when a cached bearer token goes stale. `test/admin.mjs` covers website/user/team CRUD, team membership, the composite onboarding tool, and confirms every destructive tool refuses to run without `confirm=true`.

## Verified against

Umami v3 API reference as of August 2026: `/websites`, `/websites/:id`, `/websites/:id/stats`, `/pageviews`, `/metrics`, `/metrics/expanded`, `/events/series`, `/active`, `/daterange`, `/sessions`, `/sessions/:id`, `/sessions/:id/activity`, `/websites/:id/reset`, `/users`, `/admin/users`, `/users/:id`, `/users/:id/websites`, `/users/:id/teams`, `/teams`, `/teams/join`, `/teams/:id`, `/teams/:id/users`, `/teams/:id/users/:userId`, `/teams/:id/websites`. Cloud requests go to `https://api.umami.is/v1` with a bearer token; self-hosted requests go to `{base}/api`. User and team management endpoints only exist on self-hosted instances.

## License

MIT
