/**
 * VegaMovies (HC/VC) — HubCloud + VCloud CDN resolver for 1vegamovies.lat.
 *
 * Ported from temp/multi-clone/src/providers/solunix.rs.
 * This is the Eclipsia variant of VegaMovies that follows HubCloud links through
 * to FSL/r2/workers.dev CDN URLs. Dynamic domain is fetched from Codeberg.
 * Very similar to the Hindi vegamovies.ts but uses the Eclipsia domains manifest.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  loadHtml,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

// Old `vegamovies.market` 301-chains to 1vegamovies.lat (verified live); the
// codeberg manifest overrides cachedBase at runtime anyway.
const DEFAULT_SITE = 'https://1vegamovies.lat';
const DOMAINS_URL  = 'https://codeberg.org/eclipsia-404/eclipsia/raw/branch/main/urls.json';
const LABEL = 'VegaMovies·HC';

const BLOCKED_SUBS = ['terapiyo232'];

let cachedBase = DEFAULT_SITE;
let lastRefresh = 0;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': HI_ACCEPT_LANGUAGE };
const MOBILE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': HI_ACCEPT_LANGUAGE,
};

async function refreshDomains(signal: AbortSignal): Promise<void> {
  if (Date.now() - lastRefresh < 4 * 3600_000) return;
  const data = await siteFetchJson<{ vegamovies?: string }>(DOMAINS_URL, { timeoutMs: 6_000, signal }).catch(() => null);
  if (data?.vegamovies) cachedBase = data.vegamovies;
  lastRefresh = Date.now();
}

function isStreamable(url: string): boolean {
  const host = url.toLowerCase().split('//')[1]?.split('/')[0] ?? '';
  if (host.endsWith('.r2.cloudflarestorage.com')) return true;
  if (host.includes('fsl-buckets')) return true;
  if (host.endsWith('.workers.dev')) {
    const sub = host.replace('.workers.dev', '').split('.').pop() ?? '';
    return !BLOCKED_SUBS.includes(sub);
  }
  return false;
}

function parseQuality(text: string): string {
  const t = (text ?? '').toUpperCase();
  if (/2160P|4K|UHD/.test(t)) return '2160p';
  if (/1440|2K/.test(t)) return '1440p';
  if (/1080P/.test(t)) return '1080p';
  if (/720P/.test(t)) return '720p';
  return 'HD';
}

function inferLang(text: string): string {
  const t = text.toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi'))   langs.push('HINDI');
  if (t.includes('tamil'))   langs.push('TAMIL');
  if (t.includes('english')) langs.push('ENGLISH');
  if (langs.length > 1) return 'MULTI';
  return langs[0] ?? 'HINDI';
}

interface SearchHit {
  document?: { id?: string; post_title?: string; permalink?: string; imdb_id?: string }
}

async function resolveHubcloud(hubUrl: string, referer: string, ctx: NuvioContext): Promise<NuvioStream[]> {
  const html = await siteFetchText(hubUrl, {
    headers: { ...HEADERS, Referer: referer },
    timeoutMs: 8_000, signal: ctx.signal,
  });
  if (!html) return [];

  const phpMatch = html.match(/href="([^"]*hubcloud\.php[^"]*)"/i);
  if (!phpMatch) return [];
  const phpUrl = phpMatch[1].replace(/&amp;/g, '&');

  const html2 = await siteFetchText(phpUrl, {
    headers: { ...HEADERS, Referer: hubUrl },
    timeoutMs: 8_000, signal: ctx.signal,
  });
  if (!html2) return [];

  const streams: NuvioStream[] = [];
  const linkRe = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html2)) !== null) {
    const url = m[1];
    if (!isStreamable(url)) continue;
    const ctx_slice = html2.slice(Math.max(0, m.index - 300), m.index);
    streams.push(toStream(url, inferLang(ctx_slice), LABEL, DEFAULT_SITE, {
      quality: parseQuality(url + ctx_slice),
      headers: { ...HEADERS, Referer: phpUrl },
    }));
  }
  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  await refreshDomains(ctx.signal);
  const base = cachedBase;

  let imdbId: string | null = ctx.imdbId ?? null;
  if (!imdbId && ctx.tmdbId) {
    const ext = await siteFetchJson<{ imdb_id?: string }>(
      `https://api.themoviedb.org/3/${ctx.type === 'tv' ? 'tv' : 'movie'}/${ctx.tmdbId}/external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = ext?.imdb_id ?? null;
  }

  let hits: SearchHit[] = [];
  const query = imdbId ?? ctx.titles[0];
  const searchData = await siteFetchJson<{ hits?: SearchHit[] }>(
    `${base}/search.php?q=${encodeURIComponent(query)}&page=1&per_page=15`,
    { headers: MOBILE_HEADERS, timeoutMs: 8_000, signal: ctx.signal }
  );
  hits = searchData?.hits ?? [];
  if (hits.length === 0) return [];

  const best = (imdbId ? hits.find(h => h.document?.imdb_id === imdbId) : null) ?? hits[0];
  if (!best?.document?.permalink) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const postId = best.document.id;
  let postHtml: string | null = null;
  if (postId) {
    const json = await siteFetchJson<{ content?: { rendered?: string } }>(
      `${base}/wp-json/wp/v2/posts/${postId}`,
      { headers: MOBILE_HEADERS, timeoutMs: 12_000, signal: ctx.signal }
    );
    postHtml = json?.content?.rendered ?? null;
  }
  if (!postHtml) {
    postHtml = await siteFetchText(best.document.permalink, {
      headers: HEADERS, timeoutMs: 12_000, signal: ctx.signal,
    });
    if (postHtml) {
      const $ = loadHtml(postHtml);
      postHtml = $('.entry-content').html() ?? postHtml;
    }
  }
  if (!postHtml || isAborted(ctx.signal)) return [];

  const hubRe = /https?:\/\/hubcloud\.[a-z0-9]+\/drive\/[a-z0-9]+/gi;
  const hubUrls = [...new Set([...postHtml.matchAll(hubRe)].map(m => m[0]))].slice(0, 6);
  if (hubUrls.length === 0) return [];

  const streams: NuvioStream[] = [];
  for (const url of hubUrls) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    streams.push(...await resolveHubcloud(url, best.document.permalink, ctx).catch(() => []));
  }
  return streams;
}

export const vegamoviesHC = createNuvioProvider({
  name: 'vegamoviesHC',
  sites: [DEFAULT_SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
