/**
 * Date range resolution for Umami queries.
 *
 * Umami expects `startAt` and `endAt` as epoch milliseconds. Agents work better
 * with human phrasing, so this module accepts relative ranges ("7d", "last_month"),
 * ISO dates ("2026-08-01"), and raw epoch milliseconds.
 */

export interface ResolvedRange {
  startAt: number;
  endAt: number;
  label: string;
  /** Same duration immediately before startAt, for period-over-period comparison. */
  previous: { startAt: number; endAt: number };
}

const RELATIVE_PATTERN = /^(\d+)\s*(m|min|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|y|years?)$/i;

const NAMED_RANGES = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_year",
  "last_year",
  "mtd",
  "ytd",
  "all_time",
] as const;

export type NamedRange = (typeof NAMED_RANGES)[number];

export const RANGE_HELP =
  'Relative ("30m", "24h", "7d", "4w", "3mo", "1y"), named ("today", "yesterday", ' +
  '"this_week", "last_week", "this_month", "last_month", "this_year", "last_year", "mtd", "ytd", "all_time"), ' +
  'or an explicit ISO date via start_date/end_date.';

/** Milliseconds to add to a UTC instant to get wall-clock time in the given IANA timezone. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

/** Wall-clock time in `timeZone`, expressed as a Date whose UTC fields are the local fields. */
function toWallClock(date: Date, timeZone: string): Date {
  return new Date(date.getTime() + tzOffsetMs(date, timeZone));
}

/** Inverse of toWallClock, DST-aware via a second offset pass. */
function fromWallClock(wall: Date, timeZone: string): Date {
  const guess = new Date(wall.getTime() - tzOffsetMs(wall, timeZone));
  return new Date(wall.getTime() - tzOffsetMs(guess, timeZone));
}

function startOfDay(date: Date, timeZone: string): Date {
  const wall = toWallClock(date, timeZone);
  wall.setUTCHours(0, 0, 0, 0);
  return fromWallClock(wall, timeZone);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function startOfWeek(date: Date, timeZone: string): Date {
  const wall = toWallClock(date, timeZone);
  const dayOfWeek = wall.getUTCDay();
  wall.setUTCDate(wall.getUTCDate() - dayOfWeek);
  wall.setUTCHours(0, 0, 0, 0);
  return fromWallClock(wall, timeZone);
}

function startOfMonth(date: Date, timeZone: string, monthOffset = 0): Date {
  const wall = toWallClock(date, timeZone);
  wall.setUTCDate(1);
  wall.setUTCMonth(wall.getUTCMonth() + monthOffset);
  wall.setUTCHours(0, 0, 0, 0);
  return fromWallClock(wall, timeZone);
}

function startOfYear(date: Date, timeZone: string, yearOffset = 0): Date {
  const wall = toWallClock(date, timeZone);
  wall.setUTCMonth(0, 1);
  wall.setUTCFullYear(wall.getUTCFullYear() + yearOffset);
  wall.setUTCHours(0, 0, 0, 0);
  return fromWallClock(wall, timeZone);
}

function relativeMs(amount: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("mo")) return amount * 30 * 86400000;
  if (u.startsWith("m")) return amount * 60000;
  if (u.startsWith("h")) return amount * 3600000;
  if (u.startsWith("d")) return amount * 86400000;
  if (u.startsWith("w")) return amount * 7 * 86400000;
  if (u.startsWith("y")) return amount * 365 * 86400000;
  throw new Error(`Unrecognized time unit '${unit}'.`);
}

/** Parse an explicit date input: epoch ms, ISO date, or ISO datetime. */
function parseExplicit(value: string, timeZone: string, endOfDay: boolean): number {
  const trimmed = value.trim();

  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const wall = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const start = fromWallClock(wall, timeZone);
    return endOfDay ? addDays(start, 1).getTime() - 1 : start.getTime();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Could not parse date '${value}'. Use YYYY-MM-DD, a full ISO 8601 timestamp, or epoch milliseconds.`
    );
  }
  return parsed;
}

export interface RangeInput {
  range?: string;
  start_date?: string;
  end_date?: string;
  timezone: string;
}

export function resolveRange(input: RangeInput): ResolvedRange {
  const timeZone = input.timezone;
  const now = new Date();

  let startAt: number;
  let endAt: number;
  let label: string;

  if (input.start_date || input.end_date) {
    endAt = input.end_date ? parseExplicit(input.end_date, timeZone, true) : now.getTime();
    startAt = input.start_date
      ? parseExplicit(input.start_date, timeZone, false)
      : endAt - 7 * 86400000;
    label = `${new Date(startAt).toISOString().slice(0, 10)} to ${new Date(endAt)
      .toISOString()
      .slice(0, 10)}`;
  } else {
    const range = (input.range ?? "7d").trim().toLowerCase().replace(/[\s-]+/g, "_");
    label = range;

    const relative = RELATIVE_PATTERN.exec(range);
    if (relative) {
      endAt = now.getTime();
      startAt = endAt - relativeMs(Number(relative[1]), relative[2]);
    } else {
      switch (range) {
        case "today": {
          startAt = startOfDay(now, timeZone).getTime();
          endAt = now.getTime();
          break;
        }
        case "yesterday": {
          const todayStart = startOfDay(now, timeZone);
          startAt = addDays(todayStart, -1).getTime();
          endAt = todayStart.getTime() - 1;
          break;
        }
        case "this_week": {
          startAt = startOfWeek(now, timeZone).getTime();
          endAt = now.getTime();
          break;
        }
        case "last_week": {
          const thisWeek = startOfWeek(now, timeZone);
          startAt = addDays(thisWeek, -7).getTime();
          endAt = thisWeek.getTime() - 1;
          break;
        }
        case "this_month":
        case "mtd": {
          startAt = startOfMonth(now, timeZone).getTime();
          endAt = now.getTime();
          break;
        }
        case "last_month": {
          const thisMonth = startOfMonth(now, timeZone);
          startAt = startOfMonth(now, timeZone, -1).getTime();
          endAt = thisMonth.getTime() - 1;
          break;
        }
        case "this_year":
        case "ytd": {
          startAt = startOfYear(now, timeZone).getTime();
          endAt = now.getTime();
          break;
        }
        case "last_year": {
          const thisYear = startOfYear(now, timeZone);
          startAt = startOfYear(now, timeZone, -1).getTime();
          endAt = thisYear.getTime() - 1;
          break;
        }
        case "all_time": {
          startAt = Date.UTC(2000, 0, 1);
          endAt = now.getTime();
          break;
        }
        default:
          throw new Error(`Unrecognized range '${input.range}'. ${RANGE_HELP}`);
      }
    }
  }

  if (endAt <= startAt) {
    throw new Error("The end of the range must be after the start.");
  }

  const span = endAt - startAt;
  return {
    startAt,
    endAt,
    label,
    previous: { startAt: startAt - span, endAt: startAt - 1 },
  };
}

/** Pick a sensible bucket size for a time series given the span of the range. */
export function suggestUnit(startAt: number, endAt: number): string {
  const span = endAt - startAt;
  if (span <= 2 * 3600000) return "minute";
  if (span <= 3 * 86400000) return "hour";
  if (span <= 120 * 86400000) return "day";
  return "month";
}

export function formatRange(startAt: number, endAt: number): string {
  return `${new Date(startAt).toISOString()} to ${new Date(endAt).toISOString()}`;
}
