/**
 * VegaMovies — Typesense-indexed Indian streaming site with dynamic domains.
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/vegamovies.js.
 * The site uses a Typesense search index at /search.php (exposed through the
 * dynamic base URL from a GitHub-hosted config JSON). Posts contain NexDrive
 * links which redirect to HubCloud or direct CDN URLs.
 *
 * Domain refresh: checked every 4 h from SaurabhKaperwan's Utils repo. The old
 * `vegamovies.market` constant 301-chains to 1vegamovies.lat and is stale, so the
 * fallback now points at the current live config domain `vegamovies.gallery`;
 * refreshDomains() overrides it at runtime anyway.
 * Search: /search.php?q=QUERY — returns Typesense hits with post IDs.
 * Post content: /wp-json/wp/v2/posts/ID (falls back to raw HTML).
 * Stream extraction: scan for hubcloud.[tld]/drive/[id] patterns and follow redirects.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  siteFetchHtml,
  loadHtml,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const DEFAULT_SITE = 'https://vegamovies.gallery';
const DOMAINS_URL  = 'https://raw.githubusercontent.com/SaurabhKaperwan/Utils/refs/heads/main/urls.json';
const LABEL = 'VegaMovies';

let cachedBase = DEFAULT_SITE;
let lastRefresh = 0;
const CACHE_TTL = 4 * 60 * 60 * 1_000; // 4 h

const HEADERS = {
  'User-Agent': NUVIO_UA,
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': HI_ACCEPT_LANGUAGE,
};

const MOBILE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': HI_ACCEPT_LANGUAGE,
};

async function refreshDomains(signal: AbortSignal): Promise<void> {
  if (Date.now() - lastRefresh < CACHE_TTL) return;
  const data = await siteFetchJson<{ vegamovies?: string }>(DOMAINS_URL, {
    timeoutMs: 6_000, signal,
  }).catch(() => null);
  if (data?.vegamovies) cachedBase = data.vegamovies;
  lastRefresh = Date.now();
}

interface SearchHit {
  postId: string;
  title: string;
  permalink: string;
  imdbId: string;
  year: string | null;
}

async function searchByTitle(
  query: string,
  base: string,
  ctx: NuvioContext
): Promise<SearchHit[]> {
  const url = `${base}/search.php?q=${encodeURIComponent(query)}&page=1&per_page=15`;
  const data = await siteFetchJson<{ hits?: Array<{ document?: Record<string, unknown> }> }>(url, {
    headers: MOBILE_HEADERS,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  return (data?.hits ?? []).map(h => {
    const doc = (h.document ?? {}) as Record<string, string>;
    return {
      postId: String(doc.id ?? ''),
      title:  (String(doc.post_title ?? '')).replace(/Download\s*/gi, '').trim(),
      permalink: String(doc.permalink ?? ''),
      imdbId: String(doc.imdb_id ?? ''),
      year:   (String(doc.post_title ?? '').match(/\b(19|20)\d{2}\b/) ?? [null])[0],
    };
  });
}

async function fetchPostHtml(
  postId: string,
  permalink: string,
  base: string,
  ctx: NuvioContext
): Promise<string | null> {
  // Try WP JSON first (fast)
  const json = await siteFetchJson<{ content?: { rendered?: string } }>(
    `${base}/wp-json/wp/v2/posts/${postId}`,
    { headers: MOBILE_HEADERS, timeoutMs: 12_000, signal: ctx.signal }
  );
  if (json?.content?.rendered) return json.content.rendered;

  // HTML fallback
  const fallback = permalink || `${base}/?p=${postId}`;
  const $ = await siteFetchHtml(fallback, {
    headers: HEADERS, timeoutMs: 12_000, signal: ctx.signal
  });
  return $?.('.entry-content').html() ?? $?.('.post-content').html() ?? null;
}

function parseQuality(text: string): string {
  const t = (text ?? '').toUpperCase();
  if (/2160P|4K|UHD/.test(t)) return '2160p';
  if (/1440/.test(t)) return '1440p';
  if (/1080/.test(t)) return '1080p';
  if (/720/.test(t)) return '720p';
  if (/480/.test(t)) return '480p';
  return 'HD';
}

function inferLang(text: string): string {
  const t = text.toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi'))   langs.push('HINDI');
  if (t.includes('tamil'))   langs.push('TAMIL');
  if (t.includes('telugu'))  langs.push('TELUGU');
  if (t.includes('english')) langs.push('ENGLISH');
  if (langs.length > 1) return 'MULTI';
  return langs[0] ?? 'HINDI';
}

async function resolveHubcloud(
  hubUrl: string,
  base: string,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const html = await siteFetchText(hubUrl, {
    headers: { ...HEADERS, Referer: `${base}/` },
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  // Find PHP redirect page
  const phpMatch = html.match(/href="([^"]*hubcloud\.php[^"]*)"/i);
  if (!phpMatch) return [];
  const phpUrl = phpMatch[1].replace(/&amp;/g, '&');

  const html2 = await siteFetchText(phpUrl, {
    headers: { Referer: hubUrl },
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html2) return [];

  const streams: NuvioStream[] = [];
  // Find FSL/r2/workers.dev links
  const linkRe = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html2)) !== null) {
    const url = m[1];
    const lc = url.toLowerCase();
    if (
      lc.includes('.r2.cloudflarestorage') ||
      lc.includes('.workers.dev') ||
      lc.includes('cdn.fsl-buckets') ||
      lc.includes('hub.latent') ||
      lc.includes('hub.whistle')
    ) {
      const q = parseQuality(url + ' ' + html2.slice(Math.max(0, m.index - 200), m.index));
      const lang = inferLang(html2.slice(Math.max(0, m.index - 500), m.index));
      streams.push(toStream(url, lang, LABEL, base, {
        quality: q,
        headers: { Referer: phpUrl },
      }));
    }
  }
  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  await refreshDomains(ctx.signal);
  const base = cachedBase;

  // ani.zip usually carries the IMDb id; TMDB (keyless) is the fallback.
  let imdbId: string | null = ctx.imdbId ?? null;
  if (!imdbId && ctx.tmdbId) {
    const ext = await siteFetchJson<{ imdb_id?: string }>(
      `https://api.themoviedb.org/3/${ctx.type === 'tv' ? 'tv' : 'movie'}/${ctx.tmdbId}/external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = ext?.imdb_id ?? null;
  }

  // Search
  let hits = imdbId ? await searchByTitle(imdbId, base, ctx) : [];
  if (hits.length === 0) {
    let q = ctx.titles[0];
    if (ctx.type === 'tv' && ctx.season != null) q += ` season ${ctx.season}`;
    hits = await searchByTitle(q, base, ctx);
  }
  if (hits.length === 0) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // Pick best match
  const best = imdbId
    ? hits.find(h => h.imdbId === imdbId) ?? hits[0]
    : hits[0];
  if (!best?.postId) return [];

  const postHtml = await fetchPostHtml(best.postId, best.permalink, base, ctx);
  if (!postHtml || isAborted(ctx.signal)) return [];

  // Find HubCloud links in post HTML
  const hubRe = /https?:\/\/hubcloud\.[a-z0-9]+\/drive\/[a-z0-9]+/gi;
  const hubUrls = [...new Set([...postHtml.matchAll(hubRe)].map(m => m[0]))].slice(0, 6);
  if (hubUrls.length === 0) return [];

  const streams: NuvioStream[] = [];
  for (const url of hubUrls) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const resolved = await resolveHubcloud(url, base, ctx).catch(() => []);
    streams.push(...resolved);
  }
  return streams;
}

export const vegamovies = createNuvioProvider({
  name: 'vegamovies',
  sites: [DEFAULT_SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
