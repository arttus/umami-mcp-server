/**
 * Per-session touch sequences, for funnels and path (journey) analysis.
 *
 * Umami has no funnel or journey endpoint. Both are built here by walking every
 * session's activity trail and reducing it to an ordered list of "touches":
 * pageviews (by urlPath) and custom events (by eventName).
 */

import { UmamiClient } from "./client.js";
import type { Paged, SessionActivity, SessionSummary } from "../types.js";

const ACTIVITY_CONCURRENCY = 8;
const PAGE_SIZE = 100;

export interface Touch {
  kind: "page" | "event";
  value: string;
  at: number;
}

export interface SessionJourney {
  sessionId: string;
  touches: Touch[];
}

export interface CollectOptions {
  maxSessions?: number;
  filters?: Record<string, string>;
}

const DEFAULT_MAX_SESSIONS = 500;
const HARD_MAX_SESSIONS = 2000;

/** Fetch every session in range (capped), then that session's activity trail, concurrency-limited. */
export async function collectSessionJourneys(
  client: UmamiClient,
  websiteId: string,
  range: { startAt: number; endAt: number },
  opts: CollectOptions = {}
): Promise<{ journeys: SessionJourney[]; totalSessions: number; scanned: number }> {
  const maxSessions = Math.min(opts.maxSessions ?? DEFAULT_MAX_SESSIONS, HARD_MAX_SESSIONS);

  const sessions: SessionSummary[] = [];
  let total = 0;
  let page = 1;
  while (sessions.length < maxSessions) {
    const result = await client.get<Paged<SessionSummary>>(`/websites/${websiteId}/sessions`, {
      startAt: range.startAt,
      endAt: range.endAt,
      page,
      pageSize: PAGE_SIZE,
      ...opts.filters,
    });
    const batch = result?.data ?? [];
    total = result?.count ?? batch.length;
    sessions.push(...batch);
    if (batch.length < PAGE_SIZE || sessions.length >= total) break;
    page += 1;
  }

  const capped = sessions.slice(0, maxSessions);
  const journeys: SessionJourney[] = [];

  for (let i = 0; i < capped.length; i += ACTIVITY_CONCURRENCY) {
    const batch = capped.slice(i, i + ACTIVITY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (session): Promise<SessionJourney> => {
        const raw = await client
          .get<SessionActivity[]>(`/websites/${websiteId}/sessions/${session.id}/activity`, {
            startAt: range.startAt,
            endAt: range.endAt,
          })
          .catch(() => []);
        const activity = Array.isArray(raw) ? raw : [];
        const touches: Touch[] = activity
          .map((item) => {
            const at = new Date(item.createdAt).getTime();
            // eventType 1 = pageview, 2 = custom event, per Umami's tracker convention.
            return item.eventType === 2 && item.eventName
              ? ({ kind: "event", value: item.eventName, at } as Touch)
              : ({ kind: "page", value: item.urlPath, at } as Touch);
          })
          .sort((a, b) => a.at - b.at);
        return { sessionId: session.id, touches };
      })
    );
    journeys.push(...results);
  }

  return { journeys, totalSessions: total, scanned: capped.length };
}
