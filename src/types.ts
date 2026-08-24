export interface Website {
  id: string;
  name: string;
  domain: string;
  shareId: string | null;
  resetAt: string | null;
  userId?: string;
  teamId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface Paged<T> {
  data: T[];
  count: number;
  page: number;
  pageSize: number;
}

export interface WebsiteStats {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
  comparison?: WebsiteStats;
}

export interface MetricRow {
  x: string | null;
  y: number;
}

export interface ExpandedMetricRow {
  name: string | null;
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
}

export interface SeriesPoint {
  x: string;
  y: number;
}

export interface EventSeriesPoint {
  x: string;
  t: string;
  y: number;
}

export interface PageviewSeries {
  pageviews: SeriesPoint[];
  sessions: SeriesPoint[];
  compare?: {
    pageviews: SeriesPoint[];
    sessions: SeriesPoint[];
  };
}

export interface SessionSummary {
  id: string;
  websiteId: string;
  hostname?: string;
  browser?: string;
  os?: string;
  device?: string;
  screen?: string;
  language?: string;
  country?: string;
  region?: string;
  city?: string;
  firstAt: string;
  lastAt: string;
  visits: number;
  views: number;
  createdAt?: string;
}

export interface SessionDetail extends SessionSummary {
  distinctId?: string;
  events?: number;
  totaltime?: number;
}

export interface SessionActivity {
  createdAt: string;
  urlPath: string;
  urlQuery: string;
  referrerDomain: string;
  eventId: string;
  eventType: number;
  eventName: string;
  visitId: string;
  hasData: number;
}

export interface DateRangeResponse {
  startDate: string;
  endDate: string;
}

export interface User {
  id: string;
  username: string;
  role: "admin" | "user" | "view-only" | string;
  createdAt?: string;
  isAdmin?: boolean;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: "team-owner" | "team-manager" | "team-member" | "team-view-only" | string;
  createdAt?: string;
  updatedAt?: string;
  user?: { id: string; username: string };
}

export interface Team {
  id: string;
  name: string;
  accessCode: string;
  logoUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  members?: TeamMember[];
  _count?: { websites: number; members: number };
}

export interface ActiveVisitors {
  visitors: number;
}

export interface SavedReport {
  id: string;
  userId: string;
  websiteId: string;
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ReplaySummary {
  id: string;
  sessionId: string;
  websiteId: string;
  browser?: string;
  os?: string;
  device?: string;
  country?: string;
  city?: string | null;
  eventCount: number;
  chunkCount: number;
  startedAt: string;
  endedAt: string;
  duration: number;
  createdAt: string;
}

export interface RrwebEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface ReplayDetail {
  sessionId: string;
  events: RrwebEvent[];
}
