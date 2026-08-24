export const SERVER_NAME = "umami-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Maximum characters returned in a single tool response before truncation kicks in. */
export const CHARACTER_LIMIT = 25000;

/** Default request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30000;

/** Umami Cloud API root. */
export const CLOUD_BASE_URL = "https://api.umami.is/v1";

/** Metric breakdown types accepted by /websites/:id/metrics */
export const METRIC_TYPES = [
  "path",
  "entry",
  "exit",
  "title",
  "query",
  "referrer",
  "channel",
  "domain",
  "country",
  "region",
  "city",
  "browser",
  "os",
  "device",
  "language",
  "screen",
  "event",
  "hostname",
  "tag",
  "distinctId",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
] as const;

export type MetricType = (typeof METRIC_TYPES)[number];

/** Filter keys Umami accepts as query params on filterable endpoints. */
export const FILTER_KEYS = [
  "path",
  "referrer",
  "title",
  "query",
  "browser",
  "os",
  "device",
  "country",
  "region",
  "city",
  "language",
  "hostname",
  "tag",
  "event",
  "distinctId",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "segment",
  "cohort",
] as const;

export const TIME_UNITS = ["minute", "hour", "day", "month", "year"] as const;

/** Roles for POST /api/users and POST /api/users/:id */
export const USER_ROLES = ["admin", "user", "view-only"] as const;

/** Roles for POST /api/teams/:id/users and POST /api/teams/:id/users/:userId */
export const TEAM_MEMBER_ROLES = ["team-manager", "team-member", "team-view-only"] as const;

/** PII masking levels for session replay, per POST /api/websites/:id replayConfig. */
export const MASK_LEVELS = ["strict", "moderate"] as const;
