/**
 * 1anime — AniList-id-keyed JSON aggregator (https://1anime.app).
 *
 * Confirmed via the open-source 1Anime scraper `1Anime/nuvio-src`
 * (providers/1anivio.js + docs/API_NOTES.md): the app resolves streams from a
 * CDN edge keyed directly by AniList id, so there is no title-search step.
 *
 *   GET https://cdn-eu.1ani.me/cdn/{server}/{anilistId}/{episode}?audio={sub|dub}
 *
 * Servers (each a distinct upstream the app aggregates):
 *   - zen  : 1Anime's own self-host, dual audio.
 *   - gogo : GogoAnime / anitaku.to mirror.
 *   - kaih : AnimeKai mirror. Its streams are HARD-SUBBED (subs burned into the
 *            video). Per the provider contract that is flagged ONLY in the
 *            human `language` label, never in `source`/`name`.
 *
 * Mimics justanime.ts: one SourceResult per server×audio, sub first.
 *
 * best-effort: unverified — endpoint paths and response shape come from the
 * published scraper, not a live call (authoring IP is bot-blocked and the CDN
 * rate-limits to 10 req/min/IP). The JSON reader below is intentionally
 * shape-tolerant to absorb field-name drift.
 */

import { normalizeQuality } from '../../utils/scraping/quality.js';
import type { SourceOptions, SourceResult, StreamProvider } from '../../types/index.js';
import { fetchJson } from '../../utils/http/fetch.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const API_BASE = 'https://cdn-eu.1ani.me';
const SITE_ORIGIN = 'https://1anime.app';

// The published scraper sends a mobile UA and the edge appears to gate on it.
const UA =
  'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

interface ServerSpec {
  key: string;
  audios: Array<'sub' | 'dub'>;
  /** AnimeKai mirror burns subtitles into the video. */
  hardsub?: boolean;
}

const SERVERS: ServerSpec[] = [
  { key: 'zen', audios: ['sub', 'dub'] },
  { key: 'gogo', audios: ['sub', 'dub'] },
  { key: 'kaih', audios: ['sub', 'dub'], hardsub: true },
];

const API_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  Origin: SITE_ORIGIN,
  Referer: `${SITE_ORIGIN}/`,
  'User-Agent': UA,
};

/** `https://cdn.example/a.m3u8` → `https://cdn.example`. '' when unparseable. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Pull a stream URL out of one candidate object, tolerating many field names. */
function urlOf(item: any): string {
  if (!item) return '';
  if (typeof item === 'string') return item;
  const direct =
    (item.links && item.links.stream) ||
    item.url || item.file || item.src || item.link ||
    item.stream || item.playbackUrl || item.hls || item.mp4;
  return typeof direct === 'string' ? direct : '';
}

/**
 * Collect every stream URL (with any quality hint) from an arbitrarily-shaped
 * payload. The published scraper probes exactly these containers.
 */
function collectStreams(payload: any): Array<{ url: string; quality: string }> {
  const out: Array<{ url: string; quality: string }> = [];
  const seen = new Set<string>();
  const push = (url: unknown, quality = '') => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, quality });
  };

  // Direct single-URL shapes.
  push(payload?.links?.stream);
  push(payload?.data?.links?.stream);
  push(payload?.stream);
  push(payload?.url);

  // Array containers (plus one level of nesting).
  const buckets = [
    payload, payload?.data, payload?.result, payload?.results,
    payload?.response, payload?.sources, payload?.streams, payload?.links,
    payload?.data?.sources, payload?.data?.streams,
  ];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      push(urlOf(item), String(item?.quality || item?.resolution || item?.label || ''));
    }
  }

  // Fallback: the exact payload shape is unverified (CDN rate-limits probes), so
  // if the targeted buckets above found nothing, deep-walk the whole tree and
  // pull a stream URL out of every object/string encountered. Additive — only
  // runs when the precise path yields zero, so it cannot change a good parse.
  // Gated on a media/embed shape so poster/thumbnail URLs are not emitted as
  // fake streams.
  if (out.length === 0) {
    const streamish = (u: string): boolean =>
      /(\.m3u8|\.mpd|\.mp4|\.m4v|\.ts|\/embed\/|\/e\/|embed\.|\/hls\/|master\.|playlist|\/stream)/i.test(u);
    const pushStream = (u: unknown, q = ''): void => {
      if (typeof u === 'string' && streamish(u)) push(u, q);
    };
    const walk = (node: any): void => {
      if (!node) return;
      if (typeof node === 'string') return pushStream(node);
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      pushStream(urlOf(node), String(node.quality || node.resolution || node.label || ''));
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
    };
    walk(payload);
  }
  return out;
}

/** Resolution/referer hints live under a `meta` wrapper in the payload. */
function metaOf(payload: any): any {
  return payload?.data || payload?.result || payload?.response || payload || {};
}

async function fetchServer(
  server: ServerSpec,
  audio: 'sub' | 'dub',
  anilistId: number,
  episode: number,
  timeoutMs: number,
): Promise<SourceResult[]> {
  const url = `${API_BASE}/cdn/${server.key}/${anilistId}/${episode}?audio=${audio}`;
  const payload = await fetchJson<any>(url, { headers: API_HEADERS, timeoutMs });
  if (!payload) return [];

  const streams = collectStreams(payload);
  if (streams.length === 0) return [];

  const meta = metaOf(payload);
  const hintedReferer: string =
    meta?.metadata?.request_headers?.Referer ||
    meta?.metadata?.request_headers?.referer || '';
  const metaResolution = String(meta?.max_resolution || meta?.resolution || '');

  const audioLanguage = audio === 'dub' ? 'en' : 'ja';
  let language = audio === 'dub' ? 'English' : 'Japanese';
  // HARDSUB RULE: burned-in subs are disclosed only in the language label.
  if (server.hardsub) language += ' (Hardsub)';

  const out: SourceResult[] = [];
  for (const s of streams) {
    // zen is 1anime's own host; gogo/kaih CDNs validate Referer against their
    // own origin. Honor an explicit hint first, then the mirror's origin, then
    // the site. best-effort: unverified — the exact Referer each CDN wants was
    // not observable from here.
    const referer =
      hintedReferer ||
      (server.key === 'zen'
        ? `${SITE_ORIGIN}/`
        : (originOf(s.url) ? `${originOf(s.url)}/` : `${SITE_ORIGIN}/`));
    const headers: Record<string, string> = { Referer: referer, 'User-Agent': UA };
    const origin = originOf(referer);
    if (origin) headers.Origin = origin;

    // Edge URLs are usually already-direct HLS (pass-through); resolve any
    // embed-shaped ones to a direct m3u8/mp4, else keep the embed as a fallback.
    const res = await resolveToDirectOrEmbed(s.url, referer);
    if (!res) continue;
    const finalHeaders = res.url !== s.url && res.headers ? { 'User-Agent': UA, ...res.headers } : headers;

    out.push({
      source: `1anime-${server.key}-${audio}`,
      url: res.url,
      quality: normalizeQuality(s.quality || metaResolution || res.quality || ''),
      headers: finalHeaders,
      subtitles: [],
      audioLanguage,
      language,
      sourceType: res.sourceType,
      providerName: '1anime',
      providerKey: '1anime',
      server: `1anime-${server.key}-${audio}`,
    });
  }
  return out;
}

const provider: StreamProvider = {
  name: '1anime',
  // API edge first (what resolution actually calls); public site second.
  sites: [API_BASE, SITE_ORIGIN],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const anilistId = Number(opts.anilistId);
      // Keyed purely by AniList id — no id, nothing to do.
      if (!Number.isFinite(anilistId) || anilistId <= 0) return [];
      const episode = opts.episode ?? 1;
      const timeoutMs = Math.max(4000, Math.min(12000, opts.providerOptions?.timeoutMs ?? 10000));

      const jobs: Array<Promise<SourceResult[]>> = [];
      for (const server of SERVERS) {
        for (const audio of server.audios) {
          jobs.push(fetchServer(server, audio, anilistId, episode, timeoutMs));
        }
      }
      const settled = await Promise.allSettled(jobs);
      const out: SourceResult[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') out.push(...r.value);
      }
      return out;
    } catch {
      return [];
    }
  },

  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    // Movies are episode 1 on this API.
    return provider.single({ ...opts, episode: opts.episode ?? 1 });
  },
};

export default provider;
