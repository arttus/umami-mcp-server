/**
 * Session replay helpers.
 *
 * This Umami instance records rrweb-style event streams via /websites/:id/replays.
 * There is no dedicated heatmap endpoint: click coordinates live inside each
 * replay's IncrementalSnapshot events (source 2 = MouseInteraction), so a
 * click-heatmap is built by downloading matching replays and extracting them.
 */

import { UmamiClient } from "./client.js";
import type { Paged, ReplayDetail, ReplaySummary, RrwebEvent } from "../types.js";

const REPLAY_CONCURRENCY = 6;

// rrweb EventType.
const META_EVENT = 4;
const INCREMENTAL_SNAPSHOT = 3;
// IncrementalSource.MouseInteraction.
const MOUSE_INTERACTION_SOURCE = 2;
// MouseInteractions that represent a point-in-time click, not a drag/scroll/focus.
const CLICK_SUBTYPES = new Set([0, 1, 2, 4, 7]); // MouseUp, MouseDown, Click, DblClick, TouchStart

export interface ExtractedClick {
  x: number;
  y: number;
  pathname: string;
  viewportWidth: number;
  viewportHeight: number;
  at: number;
}

export interface ReplayPageVisit {
  href: string;
  at: number;
  viewportWidth: number;
  viewportHeight: number;
}

export function listReplays(
  client: UmamiClient,
  websiteId: string,
  range: { startAt: number; endAt: number },
  opts: { page?: number; pageSize?: number; path?: string } = {}
): Promise<Paged<ReplaySummary>> {
  return client.get<Paged<ReplaySummary>>(`/websites/${websiteId}/replays`, {
    startAt: range.startAt,
    endAt: range.endAt,
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 20,
    ...(opts.path ? { path: opts.path } : {}),
  });
}

export function getReplay(
  client: UmamiClient,
  websiteId: string,
  replayId: string
): Promise<ReplayDetail> {
  return client.get<ReplayDetail>(`/websites/${websiteId}/replays/${replayId}`);
}

/** Page visits (from Meta events) and clicks (from MouseInteraction events), in order. */
export function extractTimeline(events: RrwebEvent[]): {
  pages: ReplayPageVisit[];
  clicks: ExtractedClick[];
} {
  const pages: ReplayPageVisit[] = [];
  const clicks: ExtractedClick[] = [];
  let currentHref = "";
  let width = 0;
  let height = 0;

  for (const event of events) {
    if (event.type === META_EVENT) {
      currentHref = String(event.data.href ?? "");
      width = Number(event.data.width ?? 0);
      height = Number(event.data.height ?? 0);
      pages.push({ href: currentHref, at: event.timestamp, viewportWidth: width, viewportHeight: height });
      continue;
    }
    if (event.type !== INCREMENTAL_SNAPSHOT) continue;
    if (event.data.source !== MOUSE_INTERACTION_SOURCE) continue;
    const subtype = Number(event.data.type);
    if (!CLICK_SUBTYPES.has(subtype)) continue;
    const x = Number(event.data.x);
    const y = Number(event.data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !width || !height) continue;

    let pathname = "";
    try {
      pathname = currentHref ? new URL(currentHref).pathname : "";
    } catch {
      pathname = "";
    }

    clicks.push({ x, y, pathname, viewportWidth: width, viewportHeight: height, at: event.timestamp });
  }

  return { pages, clicks };
}

/** Fetch and extract clicks for a set of replays, concurrency-limited. */
export async function collectClicks(
  client: UmamiClient,
  websiteId: string,
  replayIds: string[]
): Promise<{ clicks: ExtractedClick[]; withDataCount: number }> {
  const clicks: ExtractedClick[] = [];
  let withDataCount = 0;

  for (let i = 0; i < replayIds.length; i += REPLAY_CONCURRENCY) {
    const batch = replayIds.slice(i, i + REPLAY_CONCURRENCY);
    const results = await Promise.all(
      batch.map((id) =>
        getReplay(client, websiteId, id)
          .then((detail) => extractTimeline(detail.events ?? []).clicks)
          .catch(() => [] as ExtractedClick[])
      )
    );
    for (const found of results) {
      if (found.length > 0) withDataCount += 1;
      clicks.push(...found);
    }
  }

  return { clicks, withDataCount };
}
