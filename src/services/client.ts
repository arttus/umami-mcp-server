/**
 * Umami API client.
 *
 * Supports two authentication modes:
 *   1. API key  (Umami Cloud, or a self-hosted key) via the Authorization header.
 *   2. Username and password (self-hosted only) via POST /auth/login, with the
 *      returned bearer token cached in memory and refreshed on a 401.
 */

import { CLOUD_BASE_URL, REQUEST_TIMEOUT_MS } from "../constants.js";

export class UmamiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string
  ) {
    super(message);
    this.name = "UmamiError";
  }
}

export interface UmamiConfig {
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  timezone: string;
  defaultWebsite?: string;
  mode: "cloud" | "self-hosted";
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * Normalize a configured base URL into a full API root.
 *  - https://analytics.example.com          -> https://analytics.example.com/api
 *  - https://analytics.example.com/api      -> unchanged
 *  - https://api.umami.is/v1                -> unchanged
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (/\/(api|v1)(\/(us|eu))?$/.test(trimmed)) return trimmed;
  return `${trimmed}/api`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UmamiConfig {
  const apiKey = env.UMAMI_API_KEY?.trim() || undefined;
  const username = env.UMAMI_USERNAME?.trim() || undefined;
  const password = env.UMAMI_PASSWORD?.trim() || undefined;
  const region = env.UMAMI_REGION?.trim().toLowerCase();
  const rawBase = env.UMAMI_BASE_URL?.trim() || undefined;

  if (!apiKey && !(username && password)) {
    throw new UmamiError(
      "Umami credentials are missing. Set UMAMI_API_KEY (Umami Cloud or a self-hosted API key), " +
        "or set UMAMI_USERNAME and UMAMI_PASSWORD together with UMAMI_BASE_URL for a self-hosted instance."
    );
  }

  let baseUrl: string;
  let mode: "cloud" | "self-hosted";

  if (rawBase) {
    baseUrl = normalizeBaseUrl(rawBase);
    mode = /(^|\.)umami\.is$/.test(new URL(baseUrl).hostname) ? "cloud" : "self-hosted";
  } else {
    if (!apiKey) {
      throw new UmamiError(
        "UMAMI_BASE_URL is required when authenticating with a username and password. " +
          "Set it to the root URL of your Umami instance, for example https://analytics.example.com"
      );
    }
    baseUrl = region === "us" || region === "eu" ? `${CLOUD_BASE_URL}/${region}` : CLOUD_BASE_URL;
    mode = "cloud";
  }

  return {
    baseUrl,
    apiKey,
    username,
    password,
    mode,
    timezone: env.UMAMI_TIMEZONE?.trim() || "UTC",
    defaultWebsite: env.UMAMI_DEFAULT_WEBSITE?.trim() || undefined,
  };
}

export class UmamiClient {
  private token?: string;
  private loginPromise?: Promise<string>;

  constructor(readonly config: UmamiConfig) {}

  get timezone(): string {
    return this.config.timezone;
  }

  get defaultWebsite(): string | undefined {
    return this.config.defaultWebsite;
  }

  private async login(): Promise<string> {
    if (!this.config.username || !this.config.password) {
      throw new UmamiError(
        "No username and password configured, so a bearer token cannot be obtained. Set UMAMI_API_KEY instead."
      );
    }
    const url = `${this.config.baseUrl}/auth/login`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new UmamiError(
        response.status === 401
          ? "Login failed. Check UMAMI_USERNAME and UMAMI_PASSWORD."
          : `Login request failed with status ${response.status}. Check that UMAMI_BASE_URL points at your Umami instance.`,
        response.status,
        "/auth/login"
      );
    }

    const body = (await response.json()) as { token?: string };
    if (!body.token) {
      throw new UmamiError("Login succeeded but no token was returned by the Umami instance.");
    }
    this.token = body.token;
    return body.token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.config.apiKey) {
      return {
        Authorization: `Bearer ${this.config.apiKey}`,
        // Older Umami Cloud deployments read the key from this header instead.
        "x-umami-api-key": this.config.apiKey,
      };
    }
    if (!this.token) {
      this.loginPromise ??= this.login().finally(() => {
        this.loginPromise = undefined;
      });
      await this.loginPromise;
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.baseUrl}${cleanPath}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { params?: QueryParams; body?: unknown; retryOnAuthFailure?: boolean } = {}
  ): Promise<T> {
    const { params, body, retryOnAuthFailure = true } = options;
    const url = this.buildUrl(path, params);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(await this.authHeaders()),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof UmamiError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new UmamiError(
        `Could not reach the Umami API at ${this.config.baseUrl} (${reason}). ` +
          "Check UMAMI_BASE_URL and that the instance is reachable from this machine.",
        undefined,
        path
      );
    }

    // A stale bearer token is worth exactly one silent retry.
    if (response.status === 401 && !this.config.apiKey && retryOnAuthFailure) {
      this.token = undefined;
      return this.request<T>(method, path, { ...options, retryOnAuthFailure: false });
    }

    if (!response.ok) {
      throw new UmamiError(describeStatus(response.status, path), response.status, path);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UmamiError(
        `Umami returned a non-JSON response for ${path}. This usually means UMAMI_BASE_URL points at the web UI rather than the API root.`,
        response.status,
        path
      );
    }
  }

  get<T>(path: string, params?: QueryParams): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  post<T>(path: string, body?: unknown, params?: QueryParams): Promise<T> {
    return this.request<T>("POST", path, { body, params });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * Admin-only endpoints (user management, cross-account listing) do not exist on
   * Umami Cloud. Fail fast with a clear message rather than a confusing 404.
   */
  requireSelfHosted(feature: string): void {
    if (this.config.mode === "cloud") {
      throw new UmamiError(
        `${feature} requires a self-hosted Umami instance with admin access. It is not available on Umami Cloud.`
      );
    }
  }
}

function describeStatus(status: number, path: string): string {
  switch (status) {
    case 400:
      return `Umami rejected the request to ${path} as malformed (400). Check the date range and any filter values.`;
    case 401:
      return "Authentication failed (401). Check UMAMI_API_KEY, or UMAMI_USERNAME and UMAMI_PASSWORD.";
    case 403:
      return `Access denied for ${path} (403). The credentials in use do not have permission for this website or team.`;
    case 404:
      return `Not found: ${path} (404). Verify the website ID, and confirm UMAMI_BASE_URL matches your Umami version.`;
    case 429:
      return "Rate limited (429). Umami Cloud allows 50 calls per 15 seconds. Wait a few seconds and retry.";
    default:
      return status >= 500
        ? `The Umami server returned ${status} for ${path}. This is a server-side error, retry shortly.`
        : `Request to ${path} failed with status ${status}.`;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof UmamiError) return `Error: ${error.message}`;
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}
