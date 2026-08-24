import { CHARACTER_LIMIT } from "./constants.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Response truncated at ${CHARACTER_LIMIT} characters. Narrow the date range, ` +
    "lower 'limit', or add filters to see the rest.]"
  );
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "0";
  return value.toLocaleString("en-US");
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function percentChange(current: number, previous: number): string {
  if (!previous) return current ? "new" : "flat";
  const delta = ((current - previous) / previous) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

/** Render an array of records as a compact markdown table. */
export function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return "_No data._";
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell)).join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** Derived metrics Umami does not return directly but every report wants. */
export function deriveStats(stats: {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}) {
  const bounceRate = stats.visits ? (stats.bounces / stats.visits) * 100 : 0;
  const viewsPerVisit = stats.visits ? stats.pageviews / stats.visits : 0;
  const avgVisitSeconds = stats.visits ? stats.totaltime / stats.visits : 0;
  return {
    bounce_rate_pct: Number(bounceRate.toFixed(1)),
    views_per_visit: Number(viewsPerVisit.toFixed(2)),
    avg_visit_duration_seconds: Math.round(avgVisitSeconds),
    avg_visit_duration_human: formatDuration(avgVisitSeconds),
  };
}
