import { z } from "zod";
import { FILTER_KEYS, METRIC_TYPES, TIME_UNITS } from "./constants.js";
import { RANGE_HELP } from "./services/dates.js";
import { ResponseFormat } from "./format.js";

export const websiteField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Website ID (UUID), name, or domain. Optional if UMAMI_DEFAULT_WEBSITE is set. Use umami_list_websites to discover values."
  );

export const rangeField = z
  .string()
  .optional()
  .describe(`Date range for the query, default '7d'. ${RANGE_HELP}`);

export const startDateField = z
  .string()
  .optional()
  .describe("Explicit start date (YYYY-MM-DD, ISO 8601 timestamp, or epoch ms). Overrides 'range'.");

export const endDateField = z
  .string()
  .optional()
  .describe("Explicit end date (YYYY-MM-DD, ISO 8601 timestamp, or epoch ms). Overrides 'range'.");

export const timezoneField = z
  .string()
  .optional()
  .describe("IANA timezone for bucketing and day boundaries, e.g. 'America/New_York'. Defaults to UMAMI_TIMEZONE.");

export const filtersField = z
  .object(
    Object.fromEntries(
      FILTER_KEYS.map((key) => [key, z.string().optional()])
    ) as Record<(typeof FILTER_KEYS)[number], z.ZodOptional<z.ZodString>>
  )
  .partial()
  .optional()
  .describe(
    `Optional segment filters. Supported keys: ${FILTER_KEYS.join(", ")}. ` +
      "Example: { country: 'US', device: 'mobile' }."
  );

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for a readable summary, 'json' for raw structured data.");

export const metricTypeField = z
  .enum(METRIC_TYPES)
  .describe(
    "What to break traffic down by. 'path' for pages, 'referrer' for referring URLs, 'channel' for acquisition channel, " +
      "'entry'/'exit' for landing and exit pages, 'event' for custom events, plus country, region, city, browser, os, device, language, screen, title, query, domain, hostname, tag, distinctId."
  );

export const unitField = z
  .enum(TIME_UNITS)
  .optional()
  .describe(
    "Bucket size for the series. Omit to pick automatically from the range. Umami caps: minute up to 60 minutes, hour up to 30 days, day up to 6 months."
  );

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(20)
  .describe("Maximum rows to return.");

export const offsetField = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Rows to skip, for pagination.");

/** Flatten a filters object into query params, dropping empty values. */
export function filtersToParams(
  filters: Record<string, string | undefined> | undefined
): Record<string, string> {
  if (!filters) return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") params[key] = value;
  }
  return params;
}

export const confirmField = z
  .literal(true)
  .describe(
    "Must be set to true to confirm this destructive, irreversible action. There is no undo."
  );
