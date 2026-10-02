/**
 * Embed69 — IMDb-keyed embed player at embed69.org.
 *
 * Ported from temp/Latino/Latino/providers/embed69.js.
 * The player URL is /f/IMDBID for movies and /f/IMDBID-SxEE for TV episodes.
 * The page contains a `dataLink` JS array whose entries are JWT tokens; each
 * token's payload carries the actual embed URL for a specific server. We decode
 * the JWTs client-side (no signature verification needed — we only want the
 * payload URL) and resolve each embed through resolveEmbedsUntil.
 *
 * Without an IMDB ID in ctx, we fall back to a title-based search of the site's
 * own search endpoint. When even that fails we return [].
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://embed69.org';
const LABEL = 'Embed69';

/** Decode a JWT payload without verifying the signature. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(payload);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  // Build the player URL. embed69 keys on IMDb ids (/f/IMDBID). Use the id
  // directly when we have one; otherwise fall back to a title search of the
  // site, whose result pages expose the /f/tt… link.
  let targetUrl: string | null = null;

  if (ctx.imdbId && /^tt\d+$/.test(ctx.imdbId)) {
    targetUrl = `${SITE}/f/${ctx.imdbId}`;
  }

  if (!targetUrl && ctx.titles[0]) {
    // Try to find via search — the page HTML often exposes the IMDb id
    const searchHtml = await siteFetchText(
      `${SITE}/?s=${encodeURIComponent(ctx.titles[0] ?? '')}`,
      {
        headers: { Referer: `${SITE}/` },
        acceptLanguage: ES_ACCEPT_LANGUAGE,
        timeoutMs: 8_000,
        signal: ctx.signal,
      }
    );
    if (searchHtml) {
      const $ = loadHtml(searchHtml);
      $('a[href*="/f/tt"]').each((_, el) => {
        if (!targetUrl) targetUrl = $(el).attr('href') ?? null;
      });
    }
  }

  // If search returned an /f/tt... link, append episode suffix for TV
  if (targetUrl && ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    const epPadded = String(ctx.episode).padStart(2, '0');
    // replace /f/IMDBID with /f/IMDBID-Sx0E
    const tu: string = targetUrl;
    targetUrl = tu.replace(/\/f\/(tt\w+).*/, `/f/$1-${ctx.season}x${epPadded}`);
  }

  if (!targetUrl) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const html = await siteFetchText(targetUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  // Extract the `dataLink` JS array containing JWT tokens
  const match = html.match(/let\s+dataLink\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) return [];

  let dataLink: unknown[];
  try { dataLink = JSON.parse(match[1]) as unknown[]; } catch { return []; }

  // Decode every JWT and collect embed URLs
  const jwtRe = /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g;
  const allTokens = html.match(jwtRe) ?? [];
  const uniqueTokens = [...new Set(allTokens)];

  const embeds: Array<{ url: string; language: string }> = [];
  for (const token of uniqueTokens) {
    if (token.length < 50) continue;
    const payload = decodeJwtPayload(token);
    if (payload?.link && typeof payload.link === 'string') {
      embeds.push({ url: payload.link, language: 'LAT' });
    }
  }

  // Also try dataLink entries directly
  for (const entry of dataLink) {
    if (typeof entry === 'string' && entry.startsWith('http')) {
      embeds.push({ url: entry, language: 'LAT' });
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const url = String(e.url ?? e.link ?? '');
      if (url.startsWith('http')) {
        const lang = String(e.lang ?? e.language ?? 'latino');
        embeds.push({ url, language: lang.toLowerCase().includes('cast') ? 'CAST' : 'LAT' });
      }
    }
  }

  if (embeds.length === 0 || isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const embed69 = createNuvioProvider({
  name: 'embed69',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
