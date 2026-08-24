/**
 * Website resolution.
 *
 * Every stats endpoint is keyed by website UUID, but agents and humans refer to
 * sites by name or domain. This resolver accepts any of the three and caches the
 * website list briefly so a multi-tool report does not re-fetch it each time.
 */

import { UmamiClient, UmamiError } from "./client.js";
import type { Paged, Website } from "../types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_TTL_MS = 60000;

let cache: { websites: Website[]; fetchedAt: number } | undefined;

export async function fetchAllWebsites(client: UmamiClient, force = false): Promise<Website[]> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.websites;
  }

  const websites: Website[] = [];
  let page = 1;
  // Umami paginates at 10 by default; walk pages until the reported count is covered.
  for (;;) {
    const response = await client.get<Paged<Website>>("/websites", {
      includeTeams: true,
      page,
      pageSize: 100,
    });
    const batch = response?.data ?? [];
    websites.push(...batch);
    const total = response?.count ?? websites.length;
    if (batch.length === 0 || websites.length >= total || page > 20) break;
    page += 1;
  }

  cache = { websites, fetchedAt: Date.now() };
  return websites;
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * Resolve a website reference to a UUID.
 * Accepts a UUID (returned as-is), an exact or partial name, or a domain.
 */
export async function resolveWebsiteId(
  client: UmamiClient,
  reference: string | undefined
): Promise<string> {
  const ref = (reference ?? client.defaultWebsite ?? "").trim();

  if (!ref) {
    throw new UmamiError(
      "No website specified. Pass the 'website' argument (a website ID, name, or domain), " +
        "or set UMAMI_DEFAULT_WEBSITE. Call umami_list_websites to see what is available."
    );
  }

  if (UUID_PATTERN.test(ref)) return ref;

  const websites = await fetchAllWebsites(client);
  const needle = ref.toLowerCase();
  const needleDomain = normalizeDomain(ref);

  const exact = websites.filter(
    (site) =>
      site.name?.toLowerCase() === needle || normalizeDomain(site.domain ?? "") === needleDomain
  );
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    throw new UmamiError(
      `'${ref}' matches ${exact.length} websites: ${exact
        .map((site) => `${site.name} (${site.id})`)
        .join(", ")}. Pass the website ID instead.`
    );
  }

  const partial = websites.filter(
    (site) =>
      site.name?.toLowerCase().includes(needle) ||
      normalizeDomain(site.domain ?? "").includes(needleDomain)
  );
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    throw new UmamiError(
      `'${ref}' is ambiguous, matching: ${partial
        .map((site) => `${site.name} (${site.domain})`)
        .join(", ")}. Be more specific or pass the website ID.`
    );
  }

  const available = websites
    .slice(0, 15)
    .map((site) => `${site.name} (${site.domain})`)
    .join(", ");
  throw new UmamiError(
    `No website matched '${ref}'.${
      available ? ` Available websites: ${available}.` : " This account has no websites."
    }`
  );
}

export async function getWebsiteLabel(client: UmamiClient, websiteId: string): Promise<string> {
  const websites = await fetchAllWebsites(client);
  const match = websites.find((site) => site.id === websiteId);
  return match ? `${match.name} (${match.domain})` : websiteId;
}
