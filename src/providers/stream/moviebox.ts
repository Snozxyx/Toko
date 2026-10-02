/**
 * MovieBox — movie & TV stream adapter (movieboxhd.net; old moviebox.ph 301s here).
 *
 * Ported from walterwhite-69/Moviebox-API (FastAPI reference) to Toko's
 * StreamProvider contract. MovieBox is a general movie/TV catalog, so this
 * provider complements the anime-focused ones: `single()` resolves TV
 * episodes, `movie()` resolves films.
 *
 * Upstream flow (h5-api.aoneroom.com/wefeed-h5api-bff):
 *   1. GET  {API}/home?host=movieboxhd.net  → guest JWT in `x-user` header
 *   2. POST {API}/subject/search             → { items: [{ subject: { subjectId, detailPath, title, subjectType } }] }
 *   3. GET  {API}/media-player/get-domain    → player origin (e.g. https://netfilm.world)
 *   4. GET  {domain}/wefeed-h5api-bff/subject/play?subjectId=&se=&ep=&detailPath=
 *           with Referer {domain}/spa/videoPlayPage/... → { streams[], hls[], dash[], captions via step 5 }
 *   5. GET  {API}/subject/caption?format=&id=&subjectId=&detailPath= → captions[]
 *
 * Streams are direct MP4 (per-resolution) or HLS — no embed extraction needed
 * unless the play call reports no resource, in which case the watch page URL
 * is returned as a custom/embed fallback.
 */
import { normalizeQuality, detectSourceType } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { StreamProvider, SourceOptions, SourceResult, SubtitleTrack } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';

// Live site host (moviebox.ph 301s here). Drives Referer/Origin and the aoneroom
// `host=` brand key below, so Referer/Origin/host stay consistent.
const SITE_URL = 'https://movieboxhd.net';
const API_BASE = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const FALLBACK_DOMAIN = 'https://netfilm.world';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Referer: `${SITE_URL}/`,
  Origin: SITE_URL,
  'X-Client-Info': '{"timezone":"Asia/Dhaka"}',
  'X-Request-Lang': 'en',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
};

const PLAYER_HEADERS: Record<string, string> = {
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'X-Source': '',
  'sec-fetch-site': 'same-origin',
};

// ── Guest token (auto-refreshed from `x-user` / set-cookie) ─────────────────

let bearerToken: string | null = null;
let tokenFetchedAt = 0;
const TOKEN_TTL_MS = 30 * 60 * 1000;

function extractTokenFromHeader(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed?.token || null;
  } catch {
    const m = raw.match(/"token"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? null;
  }
}

function extractTokenFromCookie(raw: string | null): string | null {
  if (!raw) return null;
  return raw.match(/(?:^|[\s,;])token=([^;\s]+)/)?.[1] ?? null;
}

async function getBearerToken(timeoutMs: number): Promise<string> {
  if (bearerToken && Date.now() - tokenFetchedAt < TOKEN_TTL_MS) return bearerToken;

  try {
    // host= is the aoneroom brand key; kept in sync with SITE_URL. Verify in
    // deployment that the backend still issues a guest JWT for this brand host.
    const res = await fetchResponse(`${API_BASE}/home?host=${new URL(SITE_URL).host}`, {
      headers: DEFAULT_HEADERS,
      timeoutMs,
    });
    const headers = res.headers as unknown as {
      get(name: string): string | null;
      getSetCookie?(): string[];
    };
    bearerToken =
      extractTokenFromHeader(headers.get('x-user')) ??
      extractTokenFromCookie(headers.get('set-cookie')) ??
      (typeof headers.getSetCookie === 'function'
        ? extractTokenFromCookie(headers.getSetCookie().join('; '))
        : null);
  } catch {
    bearerToken = null;
  }
  tokenFetchedAt = Date.now();
  return bearerToken ?? '';
}

/** API GET/POST with guest auth; never throws — failures return null. */
async function apiRequest<T>(
  url: string,
  init: {
    method?: 'GET' | 'POST';
    payload?: unknown;
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<T | null> {
  const { method = 'GET', payload, timeoutMs = 8000, headers = {} } = init;
  const token = await getBearerToken(timeoutMs);
  try {
    const res = await fetchResponse(url, {
      method,
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      timeoutMs,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── Upstream shapes ─────────────────────────────────────────────────────────

interface MbSubject {
  subjectId?: string;
  subjectType?: number; // 1 = movie, 2 = series
  title?: string;
  detailPath?: string;
  releaseDate?: string;
  imdbRatingValue?: string;
  hasResource?: boolean;
}

interface MbSearchResponse {
  code?: number;
  data?: { items?: Array<{ subject?: MbSubject } | MbSubject>; list?: Array<{ subject?: MbSubject } | MbSubject> };
}

interface MbStream {
  id?: string;
  resolutions?: number | string;
  format?: string;
  url?: string;
  size?: number;
  codecName?: string;
}

interface MbPlayResponse {
  code?: number;
  data?: {
    streams?: MbStream[];
    hls?: MbStream[];
    dash?: MbStream[];
    hasResource?: boolean;
    freeNum?: number;
  };
}

interface MbCaption {
  id?: string;
  language?: string;
  name?: string;
  url?: string;
}

// ── Player domain cache ─────────────────────────────────────────────────────

let playerDomain: string | null = null;
let domainFetchedAt = 0;

async function getPlayerDomain(timeoutMs: number): Promise<string> {
  if (playerDomain && Date.now() - domainFetchedAt < TOKEN_TTL_MS) return playerDomain;
  const data = await apiRequest<{ data?: string }>(`${API_BASE}/media-player/get-domain`, { timeoutMs });
  const domain = String(data?.data || '').replace(/\/+$/, '');
  playerDomain = domain || FALLBACK_DOMAIN;
  domainFetchedAt = Date.now();
  return playerDomain;
}

// ── Search ──────────────────────────────────────────────────────────────────

interface MbHit {
  subjectId: string;
  detailPath: string;
  title: string;
  isMovie: boolean;
}

function normalizeSubjects(payload: MbSearchResponse | null): MbSubject[] {
  const raw = payload?.data?.items ?? payload?.data?.list ?? [];
  const out: MbSubject[] = [];
  for (const item of raw) {
    const subject = (item as { subject?: MbSubject })?.subject ?? (item as MbSubject);
    if (subject?.subjectId && subject?.detailPath) out.push(subject);
  }
  return out;
}

async function searchSubjects(titles: string[], prefer: 'movie' | 'series', timeoutMs: number): Promise<MbHit | null> {
  const queries = buildSearchQueries(titles).slice(0, 2);
  let fallback: MbHit | null = null;

  for (const query of queries) {
    const payload = await apiRequest<MbSearchResponse>(`${API_BASE}/subject/search`, {
      method: 'POST',
      payload: { keyword: query, page: 1, perPage: 12 },
      timeoutMs,
    });
    const subjects = normalizeSubjects(payload);
    if (subjects.length === 0) continue;

    let best: { subject: MbSubject; score: number } | null = null;
    for (const subject of subjects) {
      const title = String(subject.title || '');
      const score = scoreMatch(query, title);
      if (!best || score > best.score) best = { subject, score };
    }
    if (!best) continue;

    const hit: MbHit = {
      subjectId: String(best.subject.subjectId),
      detailPath: String(best.subject.detailPath),
      title: String(best.subject.title || ''),
      isMovie: best.subject.subjectType !== 2,
    };

    // A strong match wins outright; otherwise keep the best-scoring hit as a
    // fallback in case no later query scores above the threshold either.
    if (best.score >= 0.45) {
      const typeMatches = prefer === 'movie' ? hit.isMovie : !hit.isMovie;
      if (typeMatches || best.score >= 0.75) return hit;
      if (!fallback) fallback = hit;
    } else if (!fallback) {
      fallback = hit;
    }
  }
  return fallback;
}

// ── Stream resolution ───────────────────────────────────────────────────────

function playerReferer(domain: string, detailPath: string, subjectId: string, se: number, ep: number): string {
  return (
    `${domain}/spa/videoPlayPage/movies/${detailPath}` +
    `?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`
  );
}

async function fetchCaptions(
  domain: string,
  hit: MbHit,
  se: number,
  ep: number,
  timeoutMs: number,
): Promise<SubtitleTrack[]> {
  try {
    const playUrl =
      `${domain}/wefeed-h5api-bff/subject/play?subjectId=${hit.subjectId}&se=${se}&ep=${ep}&detailPath=${hit.detailPath}`;
    const play = await apiRequest<MbPlayResponse>(playUrl, {
      timeoutMs,
      headers: {
        ...PLAYER_HEADERS,
        Referer: playerReferer(domain, hit.detailPath, hit.subjectId, se, ep),
        Origin: domain,
      },
    });
    const first = play?.data?.streams?.[0] ?? play?.data?.hls?.[0] ?? play?.data?.dash?.[0];
    if (!first?.id) return [];

    const capUrl =
      `${API_BASE}/subject/caption?format=${first.format || 'MP4'}&id=${first.id}` +
      `&subjectId=${hit.subjectId}&detailPath=${hit.detailPath}`;
    const capPayload = await apiRequest<{ data?: { captions?: MbCaption[] } | MbCaption[] }>(capUrl, { timeoutMs });
    const inner = capPayload?.data;
    const captions = Array.isArray(inner) ? inner : inner?.captions ?? [];

    return captions
      .filter((c) => Boolean(c?.url))
      .map((c) => ({
        url: String(c.url),
        label: c.name || c.language || 'Subtitle',
        language: c.language || 'en',
      }));
  } catch {
    return [];
  }
}

function mapStreams(
  streams: MbStream[] | undefined,
  domain: string,
  hit: MbHit,
  subtitles: SubtitleTrack[],
): SourceResult[] {
  const out: SourceResult[] = [];
  const seen = new Set<string>();

  for (const s of streams ?? []) {
    const url = String(s?.url || '');
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);

    const isHls = /\.m3u8($|[?#])/i.test(url) || String(s?.format || '').toUpperCase() === 'HLS';
    const resLabel = s?.resolutions ? `${s.resolutions}p` : isHls ? 'auto' : 'HD';

    out.push({
      source: `moviebox-${isHls ? 'hls' : resLabel}`,
      url,
      quality: normalizeQuality(resLabel),
      headers: {
        Referer: `${domain}/`,
        Origin: domain,
        'User-Agent': UA,
      },
      subtitles,
      audioLanguage: 'en',
      language: 'English',
      sourceType: isHls ? 'hls' : 'mp4',
      providerName: 'MovieBox',
      providerKey: 'moviebox',
      server: `moviebox-${resLabel}`,
    });
  }
  return out;
}

async function resolve(opts: SourceOptions, prefer: 'movie' | 'series'): Promise<SourceResult[]> {
  const timeoutMs = Math.max(4000, Math.min(12000, opts.providerOptions?.timeoutMs ?? 9000));
  const titles = (opts.titles || []).filter(Boolean);
  if (titles.length === 0) return [];

  const hit = await searchSubjects(titles, prefer, timeoutMs);
  if (!hit) return [];

  // MovieBox seasons: SourceOptions carries no season field, so series lookups
  // resolve against season 1 (the season most catalogs are keyed by).
  const se = 1;
  const ep = opts.episode ?? 1;
  const domain = await getPlayerDomain(timeoutMs);

  const playUrl =
    `${domain}/wefeed-h5api-bff/subject/play?subjectId=${hit.subjectId}&se=${se}&ep=${ep}&detailPath=${hit.detailPath}`;
  const play = await apiRequest<MbPlayResponse>(playUrl, {
    timeoutMs,
    headers: {
      ...PLAYER_HEADERS,
      Referer: playerReferer(domain, hit.detailPath, hit.subjectId, se, ep),
      Origin: domain,
    },
  });
  const data = play?.data;

  const subtitles = await fetchCaptions(domain, hit, se, ep, timeoutMs);

  const results: SourceResult[] = [
    ...mapStreams(data?.streams, domain, hit, subtitles),
    ...mapStreams(data?.hls, domain, hit, subtitles),
  ];
  if (results.length > 0) return results;

  // No direct resource (VIP-locked / region-locked / wrong match) — return the
  // site watch page as an embed fallback so the app can still open it.
  if (data?.hasResource === false || data === undefined) {
    return [
      {
        source: 'moviebox',
        url: `${SITE_URL}/detail/${hit.detailPath}`,
        quality: normalizeQuality('HD'),
        headers: { Referer: `${SITE_URL}/`, 'User-Agent': UA },
        subtitles: [],
        audioLanguage: 'en',
        language: 'English',
        sourceType: 'custom',
        providerName: 'MovieBox',
        providerKey: 'moviebox',
        server: 'moviebox-web',
      },
    ];
  }

  return [];
}

const provider: StreamProvider = {
  name: 'moviebox',
  sites: [SITE_URL, API_BASE, FALLBACK_DOMAIN],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      return await resolve(opts, 'series');
    } catch {
      return [];
    }
  },

  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      return await resolve({ ...opts, episode: opts.episode ?? 1 }, 'movie');
    } catch {
      return [];
    }
  },
};

export default provider;
