/**
 * Shared toolkit for every provider ported from the Nuvio repos.
 *
 * The four upstream repos each carry their own copy of the same utilities —
 * per-domain rate limiting, slugification, title scoring, budget checks, a
 * `toStream` builder. Ported 68 times over that would be 68 chances to diverge,
 * so the common parts live here and each port keeps only its site-specific
 * scraping.
 *
 * Two upstream helpers are deliberately *not* reproduced:
 *
 *   `metadata.js` / `search-fallback.js` — both hit TMDB directly with a
 *   hardcoded API key to recover a localized title. `ctx.titles` already arrives
 *   localized from ani.zip, so the key (and the extra round trip) is unnecessary.
 *
 *   `dle-extractor.js`'s ArmSync block — it called arm.haglund.dev for an IMDb
 *   id and then Cinemeta for an episode list purely to derive an absolute episode
 *   number. ani.zip returns `absoluteEpisodeNumber` in the same response the
 *   season/episode mapping comes from, so `ctx.absoluteEpisode` replaces two
 *   network hops with a field read.
 */

import { loadHtml, type TokoCheerio } from '../../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../../utils/common/fetch-bypass.js';
import { resolveStream, type ResolvedStreamResult } from '../../../utils/resolvers/index.js';
import type { NuvioStream } from './adapter.js';

export { loadHtml };
export type { TokoCheerio };

/** Chrome UA shared by every ported provider; several sites gate on it. */
export const NUVIO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

/** Browser-shaped headers. Sites behind Cloudflare reject bare requests. */
export function siteHeaders(
  siteUrl: string,
  language = 'en-US,en;q=0.9',
  extra: Record<string, string> = {}
): Record<string, string> {
  const origin = getUrlOrigin(siteUrl, siteUrl);
  return {
    'User-Agent': NUVIO_UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': language,
    Referer: `${origin}/`,
    Origin: origin,
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  };
}

/** French sites index French names and some vary content by Accept-Language. */
export const FR_ACCEPT_LANGUAGE = 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';
export const ES_ACCEPT_LANGUAGE = 'es-ES,es;q=0.9,en;q=0.8';
export const HI_ACCEPT_LANGUAGE = 'en-IN,en;q=0.9,hi;q=0.8';

// ── Time and budget ──────────────────────────────────────────────────────────

/** Default per-provider budget. Below the adapter's 20s so it can finish tidily. */
export const PROVIDER_BUDGET_MS = 16_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAborted(signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted);
}

export function isBudgetExhausted(startTime: number, budgetMs = PROVIDER_BUDGET_MS): boolean {
  return Date.now() - startTime > budgetMs;
}

/**
 * Cap one operation's duration.
 *
 * Resolves to `null` on timeout rather than rejecting: a slow embed host is a
 * normal outcome, and every caller would otherwise wrap this in a try/catch that
 * discards the error anyway.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Rate limiting ────────────────────────────────────────────────────────────

const lastRequestAt = new Map<string, number>();
const DEFAULT_MIN_INTERVAL_MS = 250;

/**
 * Space out requests to one host.
 *
 * The runner fans out ~68 providers at once and several of them share a host
 * family (three voiranime mirrors, two anime-sama domains). Without this they
 * arrive as a burst, which is exactly the pattern that earns a Cloudflare
 * challenge — and solving one costs 45s of browser time.
 */
export async function rateLimit(
  domain: string,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS
): Promise<void> {
  const now = Date.now();
  const previous = lastRequestAt.get(domain) ?? 0;
  const wait = previous + minIntervalMs - now;
  lastRequestAt.set(domain, wait > 0 ? previous + minIntervalMs : now);
  if (wait > 0) await sleep(wait);
}

// ── Fetching ─────────────────────────────────────────────────────────────────

export interface SiteFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
  form?: Record<string, string>;
  signal?: AbortSignal | null;
  /** Accept-Language for the request. Defaults to English. */
  acceptLanguage?: string;
  /** Skip the browser escalation (use for cheap probes that may 404). */
  noBypass?: boolean;
  /**
   * Minimum gap between requests to this host, overriding the shared default.
   *
   * A handful of these sites answer 429 well below the default pace and then
   * blacklist the caller for minutes, which costs far more than pacing does.
   */
  minIntervalMs?: number;
}

/**
 * GET/POST a site page as text, with Cloudflare bypass and rate limiting.
 *
 * Every ported provider goes through this rather than `fetchText` so the bypass
 * applies uniformly: half the reason these sites were unreachable from a plain
 * scraper is a managed challenge, and wiring that per-provider would guarantee
 * some of them missed it.
 */
export async function siteFetchText(
  url: string,
  options: SiteFetchOptions = {}
): Promise<string | null> {
  if (isAborted(options.signal)) return null;

  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  await rateLimit(host, options.minIntervalMs);
  if (isAborted(options.signal)) return null;

  const headers = {
    ...siteHeaders(url, options.acceptLanguage ?? 'en-US,en;q=0.9'),
    ...(options.headers || {}),
  };

  let body = options.body;
  if (options.form) {
    body = new URLSearchParams(options.form).toString();
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
  }

  return fetchTextWithBypass(url, {
    headers,
    timeoutMs: options.timeoutMs ?? 12_000,
    method: options.method ?? (body ? 'POST' : 'GET'),
    body,
    noBypass: options.noBypass,
  });
}

/** Same as `siteFetchText`, parsed as JSON. Tolerates JSON wrapped in markup. */
export async function siteFetchJson<T = unknown>(
  url: string,
  options: SiteFetchOptions = {}
): Promise<T | null> {
  const text = await siteFetchText(url, {
    ...options,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(options.headers || {}),
    },
  });
  if (!text) return null;

  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed) as T;
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(trimmed.substring(first, last + 1)) as T;
    }
    const firstArr = trimmed.indexOf('[');
    const lastArr = trimmed.lastIndexOf(']');
    if (firstArr !== -1 && lastArr > firstArr) {
      return JSON.parse(trimmed.substring(firstArr, lastArr + 1)) as T;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** Fetch and parse in one step. */
export async function siteFetchHtml(
  url: string,
  options: SiteFetchOptions = {}
): Promise<TokoCheerio | null> {
  const html = await siteFetchText(url, options);
  return html ? loadHtml(html) : null;
}

// ── Text and slug helpers ────────────────────────────────────────────────────

/** Strip diacritics so "Démon" and "Demon" compare equal. */
export function deaccent(value: string): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Title → URL slug: lowercased, unaccented, punctuation collapsed to hyphens. */
export function toSlug(title: string): string {
  return deaccent(String(title || '').toLowerCase())
    .replace(/[':!.,?()[\]/–—"]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Normalize for comparison: lowercase, unaccented, punctuation → single spaces. */
export function normalize(value: string): string {
  return deaccent(String(value || '').toLowerCase())
    .replace(/[':!.,?()[\]/-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop a trailing season marker.
 *
 * Upstream discovered this matters: searching "No Longer Allowed in Another
 * World Season 1" returns nothing on sites that only index the base title, while
 * the stripped form finds it. Kept because ani.zip titles carry the same
 * suffixes for split-cour entries.
 */
export function stripSeasonSuffix(title: string): string {
  if (!title) return title;
  const cleaned = String(title)
    .replace(/\s+(?:Season|Saison|Stagione|Temporada|Sezon)\s+\d+\s*$/i, '')
    .replace(/\s+S\d+\s*$/i, '')
    .replace(/\s+(?:Part|Partie|Cour)\s+\d+\s*$/i, '')
    .trim();
  return cleaned || title;
}

/**
 * Words that describe packaging rather than identity.
 *
 * Used by the extra-word penalty so "Naruto Shippuden" is not rewarded for
 * matching a "Naruto" query while "Naruto VOSTFR Saison 2" is not punished for
 * carrying release metadata.
 */
export const TITLE_NOISE_WORDS = new Set([
  'saison', 'saisons', 'season', 'seasons', 'temporada', 'stagione',
  'partie', 'part', 'parties', 'cour', 'integrale', 'integrales',
  'vol', 'film', 'films', 'movie', 'pelicula', 'ova', 'ona', 'special', 'specials',
  'the', 'le', 'la', 'les', 'des', 'une', 'de', 'du', 'et', 'au', 'aux', 'el', 'los', 'las', 'y',
  'vostfr', 'vost', 'vf', 'vff', 'vfq', 'vo', 'french', 'latino', 'castellano',
  'streaming', 'online', 'gratis', 'hindi', 'dubbed', 'sub', 'subtitulado',
]);

/** Significant words in `resultTitle` that the query never asked for. */
export function countExtraWords(resultTitle: string, searchTitle: string): number {
  const queryWords = new Set(
    String(searchTitle || '').split(/\s+/).filter((w) => w.length > 2)
  );
  return String(resultTitle || '')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 2 &&
        !/^\d+$/.test(w) &&
        !TITLE_NOISE_WORDS.has(w) &&
        !queryWords.has(w)
    ).length;
}

export interface MatchScores {
  EXACT_MATCH: number;
  STRONG_MATCH: number;
  MIN_MATCH: number;
}

export const DEFAULT_SCORES: MatchScores = {
  EXACT_MATCH: 100,
  STRONG_MATCH: 80,
  MIN_MATCH: 30,
};

/**
 * Score a search result against a query title.
 *
 * The extra-word penalty is the part that earns its keep: a bare substring test
 * ranks "Naruto Shippuden Kai" (a fan edit) as a perfect hit for "Naruto", and
 * these catalogues are full of derivative uploads. Each unexpected significant
 * word costs 25 points, floored so a strong match can never fall below
 * `MIN_MATCH + 5` on word count alone.
 */
export function scoreTitleMatch(
  resultTitle: string,
  searchTitle: string,
  scores: MatchScores = DEFAULT_SCORES
): number {
  const query = normalize(searchTitle);
  const result = normalize(resultTitle);
  if (!query || !result) return 0;
  if (result === query) return scores.EXACT_MATCH;

  if (result.includes(query) || query.includes(result)) {
    const extra = countExtraWords(result, query);
    if (extra > 0) {
      const penalty = Math.min(
        extra * 25,
        scores.STRONG_MATCH - scores.MIN_MATCH - 5
      );
      return Math.max(scores.STRONG_MATCH - penalty, 0);
    }
    return scores.STRONG_MATCH;
  }

  const words = query.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const resultWords = new Set(result.split(/\s+/));
  const matched = words.filter((w) => resultWords.has(w)).length;
  return Math.round((matched / words.length) * 50);
}

/** Best-scoring candidate above `minScore`, or null. */
export function pickBestMatch<T>(
  candidates: T[],
  query: string,
  titleOf: (candidate: T) => string,
  minScore = DEFAULT_SCORES.MIN_MATCH
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreTitleMatch(titleOf(candidate), query);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= minScore ? best : null;
}

// ── URLs ─────────────────────────────────────────────────────────────────────

export function getUrlOrigin(url: string, fallback = ''): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

/** Resolve a possibly-relative href against a base. Returns '' when unusable. */
export function absoluteUrl(href: string, base: string): string {
  const value = String(href || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

/** Decode HTML entities in scraped attribute values. */
export function decodeEntities(value: string): string {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Decode a base64 payload in either Node or a browser runtime. */
export function decodeBase64(value: string): string {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const globalBuffer = (globalThis as unknown as {
      Buffer?: { from(s: string, enc: string): { toString(enc: string): string } };
    }).Buffer;
    if (globalBuffer) return globalBuffer.from(input, 'base64').toString('utf-8');
  } catch {
    /* fall through to atob */
  }
  try {
    return atob(input);
  } catch {
    return '';
  }
}

// ── Language ─────────────────────────────────────────────────────────────────

/**
 * Canonicalize a site's language tag to the form the ports pass upward.
 *
 * Stays in the site's own vocabulary (VF/VOSTFR/LAT/CAST) rather than mapping to
 * BCP 47 here — `normalizeStreamLanguage` in the adapter owns that translation,
 * and it needs the distinction intact: VOSTFR means Japanese audio, so
 * collapsing it to 'fr' this early would lose the only signal that says so.
 */
export function normalizeLangTag(lang: string | undefined): string {
  const value = String(lang || '').toLowerCase().trim();
  if (!value) return 'VOSTFR';
  if (/vostfr|vost\b|sub\s*fr|subfr/.test(value)) return 'VOSTFR';
  if (/vff|vfq|vfi|vfb|truefrench|\bvf\b|french|francais/.test(value)) return 'VF';
  if (/latino|\blat\b|espanol\s*latino/.test(value)) return 'LAT';
  if (/castellano|\bcast\b|espanol/.test(value)) return 'CAST';
  if (/subtitulado|\bsubesp\b|\bsub\b/.test(value)) return 'SUBESP';
  if (/dublado|\bdub\b/.test(value)) return 'DUB';
  if (/legendado|\bleg\b/.test(value)) return 'LEG';
  if (/hindi|\bhin\b/.test(value)) return 'HINDI';
  if (/english|\beng\b/.test(value)) return 'ENGLISH';
  if (/multi|dual/.test(value)) return 'MULTI';
  if (value === 'default') return 'MULTI';
  if (value === 'vo') return 'VO';
  return value.toUpperCase();
}

// ── Season parsing ───────────────────────────────────────────────────────────

/** Every season number a pattern's first capture group finds, ascending. */
export function parseAvailableSeasons(html: string, pattern: RegExp): number[] {
  if (!html) return [];
  const seasons = new Set<number>();
  const regex = new RegExp(pattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value)) seasons.add(value);
  }
  return [...seasons].sort((a, b) => a - b);
}

// ── Episode-link selection ───────────────────────────────────────────────────

/**
 * Pick an episode's href from a season/detail page by season+episode number.
 *
 * The ported scrapers used `a[href*="${season}"][href*="${episode}"]`, a bare
 * substring match that for low numbers (S1E1) matches almost any anchor — so the
 * wrong link was followed. This scans every anchor and matches the real Latino
 * URL shapes precisely, preferring the most specific:
 *   1. `1x01` / `1x1`           (SxE, zero-pad tolerant)
 *   2. `temporada-1 … capitulo-2` / `…-episodio-2` (both numbers, in order)
 *   3. `/1-2/` or `-1-2-`       (season-episode pair on word boundaries)
 */
export function pickEpisodeHref(
  $: TokoCheerio,
  season: number,
  episode: number,
): string | null {
  const sxe = new RegExp(`(?:^|[^0-9])${season}x0*${episode}(?:[^0-9]|$)`, 'i');
  const tempCap = new RegExp(
    `temporada[^0-9]*${season}[^0-9][\\s\\S]*?(?:cap(?:itulo)?|ep(?:isodio)?)[^0-9]*0*${episode}(?:[^0-9]|$)`,
    'i',
  );
  const pair = new RegExp(`(?:^|[^0-9])${season}[-_x]0*${episode}(?:[^0-9]|$)`, 'i');

  let best: string | null = null;
  let bestRank = 99;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href) return;
    const hay = `${href} ${$(el).text() ?? ''}`;
    let rank = 99;
    if (sxe.test(hay)) rank = 0;
    else if (tempCap.test(hay)) rank = 1;
    else if (pair.test(hay)) rank = 2;
    if (rank < bestRank) {
      bestRank = rank;
      best = href;
    }
  });
  return best;
}

// ── Server naming ────────────────────────────────────────────────────────────

const SERVER_NAMES: Array<[RegExp, string]> = [
  [/sibnet/i, 'Sibnet'],
  [/vidmoly/i, 'Vidmoly'],
  [/sendvid|daisukianime/i, 'Sendvid'],
  [/voe|weneverbeenfree|maryspecialwatch/i, 'Voe'],
  [/stape|streamtape/i, 'Streamtape'],
  [/dood|ds2play|d0000d|d000d/i, 'Doodstream'],
  [/uqload|oneupload/i, 'Uqload'],
  [/filemoon|moonplayer/i, 'Filemoon'],
  [/lulu(?:vid|stream|vdo)|wishonly|veev/i, 'Luluvid'],
  [/mail\.ru|my\.mail/i, 'MailRu'],
  [/vidoza/i, 'Vidoza'],
  [/younetu|netu\./i, 'Younetu'],
  [/fsvid|vidzy/i, 'Vidzy'],
  [/mixdrop/i, 'Mixdrop'],
  [/upstream/i, 'Upstream'],
  [/streamwish|wishfast|awish|swhoi/i, 'StreamWish'],
  [/vidhide|vidhidepro|filelions|kinoger/i, 'VidHide'],
  [/streamsb|sbfull|playersb/i, 'StreamSB'],
  [/okru|ok\.ru/i, 'OK.ru'],
  [/vk\.com|vkvideo/i, 'VK'],
  [/burstcloud/i, 'BurstCloud'],
  [/hgcloud|savefiles/i, 'SaveFiles'],
  [/lecteurvideo/i, 'LecteurVideo'],
  [/up4fun/i, 'Up4Fun'],
  [/down-paradise/i, 'DownParadise'],
  [/myvi|mytv/i, 'MyTV'],
  [/vidstream|vidcdn|kakaflix/i, 'VidStream'],
  [/fembed|femax/i, 'Fembed'],
  [/goodstream|gdrive|drive\.google/i, 'GDrive'],
  [/\.m3u8/i, 'Direct HLS'],
  [/\.mp4/i, 'Direct MP4'],
];

/** Friendly server label inferred from the host. Falls back to the hostname. */
export function serverNameFor(url: string): string {
  const value = String(url || '');
  for (const [pattern, name] of SERVER_NAMES) {
    if (pattern.test(value)) return name;
  }
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return 'Player';
  }
}

// ── Stream construction ──────────────────────────────────────────────────────

export interface ToStreamOptions {
  quality?: string;
  title?: string;
  server?: string;
  size?: string;
  type?: string;
  headers?: Record<string, string>;
  subtitles?: NuvioStream['subtitles'];
}

/**
 * Build one `NuvioStream`.
 *
 * Referer/Origin default to the *media* host rather than the site, because that
 * is what embed CDNs check — several return 403 when handed the catalogue's
 * origin. The adapter fills in the site origin only when nothing is set at all.
 */
export function toStream(
  url: string,
  language: string,
  providerLabel: string,
  siteUrl: string,
  options: ToStreamOptions = {}
): NuvioStream {
  const origin = getUrlOrigin(url, siteUrl);
  const quality = options.quality || 'HD';
  const server = options.server || serverNameFor(url);

  const stream: NuvioStream = {
    url,
    name: `${providerLabel} (${language})`,
    title:
      options.title ||
      `[${language}] ${providerLabel} · ${server}${
        quality && quality !== 'HD' ? ` [${quality}]` : ''
      }`,
    quality,
    language,
    server,
    headers: {
      Referer: `${origin}/`,
      Origin: origin,
      'User-Agent': NUVIO_UA,
      ...(options.headers || {}),
    },
  };

  if (options.size) stream.size = options.size;
  if (options.type) stream.type = options.type;
  if (options.subtitles?.length) stream.subtitles = options.subtitles;
  return stream;
}

// ── Embed resolution ─────────────────────────────────────────────────────────

export interface ResolveEmbedOptions {
  language: string;
  providerLabel: string;
  siteUrl: string;
  quality?: string;
  server?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  subtitles?: NuvioStream['subtitles'];
}

/**
 * Turn one embed URL into playable `NuvioStream`s.
 *
 * Unresolvable embeds yield `[]` on purpose. Handing the player an embed page
 * produces a source that appears in the list and then fails on click, which is
 * worse than the provider looking empty and the next one being tried.
 */
export async function resolveEmbedStreams(
  embedUrl: string,
  options: ResolveEmbedOptions
): Promise<NuvioStream[]> {
  const url = String(embedUrl || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return [];

  const resolved = await withTimeout(
    resolveStream({
      url,
      headers: options.headers,
      quality: options.quality,
      language: options.language,
      server: options.server,
    }),
    options.timeoutMs ?? 9_000
  );
  if (!resolved || resolved.length === 0) return [];

  return resolved.map((item: ResolvedStreamResult) =>
    toStream(item.url, options.language, options.providerLabel, options.siteUrl, {
      quality: item.quality || options.quality,
      server: options.server || serverNameFor(url),
      type: item.type,
      headers: item.headers,
      subtitles: options.subtitles,
    })
  );
}

/**
 * Resolve several embeds, stopping once `target` streams are playable.
 *
 * Sequential rather than parallel, and that is intentional in two ways. The
 * upstream repos found `Promise.all` gave no speedup in their QuickJS runtime,
 * but the reason it stays sequential here is different: embeds for one episode
 * usually live on the same few CDNs, so firing them together triggers the rate
 * limiter or a challenge. Stopping early also means the common case — the first
 * host works — costs one request instead of five.
 */
export async function resolveEmbedsUntil(
  embeds: Array<{ url: string; language?: string; quality?: string; server?: string }>,
  options: ResolveEmbedOptions & { target?: number; signal?: AbortSignal | null; budgetMs?: number }
): Promise<NuvioStream[]> {
  const target = options.target ?? 3;
  const startTime = Date.now();
  const budgetMs = options.budgetMs ?? 12_000;
  const out: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const embed of embeds) {
    if (out.length >= target) break;
    if (isAborted(options.signal)) break;
    if (isBudgetExhausted(startTime, budgetMs)) break;

    const url = String(embed?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const streams = await resolveEmbedStreams(url, {
      ...options,
      language: embed.language || options.language,
      quality: embed.quality || options.quality,
      server: embed.server || options.server,
    });
    out.push(...streams);
  }

  return out;
}

/** Every `src` on the page that looks like a video embed, in document order. */
export function collectIframeSources(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const regex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const url = absoluteUrl(decodeEntities(match[1]), baseUrl);
    if (!url || seen.has(url)) continue;
    // Ads and social embeds outnumber players on most of these pages.
    if (/doubleclick|google|facebook|twitter|disqus|recaptcha|adsbygoogle/i.test(url)) {
      continue;
    }
    seen.add(url);
    out.push(url);
  }
  return out;
}
