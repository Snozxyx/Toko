/**
 * mkissa — anime/manga discovery hub (https://mkissa.to).
 *
 * Reverse-engineered from `MALSync/MALSync` (Mkissa page) and the Mangayomi
 * anime extension `Amry-droid/mangayomi-mkissa-anime`: mkissa.to is an
 * AllAnime/AllManga clone and its data comes from the AllAnime GraphQL API, not
 * from the SPA shell (`/api/*` on the www host just returns the app bundle).
 *
 *   POST https://api.mkissa.net/api   (fallback https://api.allanime.day/api)
 *     {shows(search:{query}){edges{_id name englishName}}}   → showId
 *     {episode(showId,translationType,episodeString){sourceUrls}}
 *
 *   sourceUrls entries beginning `--` are hex-XOR(56) encoded clock paths that
 *   resolve to real links at https://allanime.day/…/clock.json; plain http(s)
 *   entries are third-party embeds.
 *
 * Uses `fetchJsonWithBypass` — the hosts sit behind Cloudflare.
 *
 * IMPORTANT LIMIT (confirmed): current mkissa builds (build 175+) gate the
 * `episode` query behind a rotating, weekly-epoch AES-GCM `aaReq` token
 * (self-bootstrapped client-side). That key material rotates and is not
 * reproducible here, so when the host demands it the query returns NEED_CAPTCHA
 * / no data and this provider yields []. The classic un-tokenised GraphQL path
 * below still works against legacy AllAnime hosts and is the honest best effort.
 *
 * best-effort: unverified — not exercised live (authoring IP is bot-blocked;
 * the API host DNS/socket was unreachable on clean-IP probes). AllAnime streams
 * are soft-subbed, so there is no hardsub concern.
 */

import { detectSourceType, normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { SourceOptions, SourceResult, StreamProvider, SubtitleTrack } from '../../types/index.js';
import { fetchJson } from '../../utils/http/fetch.js';
import { fetchJsonWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const API_HOSTS = ['https://api.mkissa.net/api', 'https://api.allanime.day/api'];
const CLOCK_BASE = 'https://allanime.day';
const SITE_ORIGIN = 'https://mkissa.to';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function apiHeaders(host: string): Record<string, string> {
  const origin = host.indexOf('mkissa.net') !== -1 ? SITE_ORIGIN : 'https://allmanga.to';
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Referer: `${origin}/`,
    Origin: origin,
    'User-Agent': UA,
  };
}

/** POST a GraphQL document to each API host until one returns `data`. */
async function gql(query: string, variables: Record<string, unknown>, timeoutMs: number): Promise<any> {
  for (const host of API_HOSTS) {
    const json = await fetchJsonWithBypass<any>(host, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: apiHeaders(host),
      timeoutMs,
    });
    if (json && json.data) return json.data;
  }
  return null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** AllAnime clock cipher: hex pairs XORed with 0x38. */
function xor56(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ 56);
  }
  return out;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'src';
}

const SEARCH_QUERY =
  'query($search:SearchInput,$limit:Int,$page:Int){shows(search:$search,limit:$limit,page:$page){edges{_id name englishName}}}';
const EPISODE_QUERY =
  'query($showId:String!,$translationType:VaildTranslationTypeEnumType!,$episodeString:String!){episode(showId:$showId translationType:$translationType episodeString:$episodeString){episodeString sourceUrls}}';

/** Resolve the AllAnime showId for the requested titles. */
async function findShowId(titles: string[], timeoutMs: number): Promise<string | null> {
  for (const query of buildSearchQueries(titles).slice(0, 3)) {
    const data = await gql(
      SEARCH_QUERY,
      { search: { allowAdult: false, allowUnknown: false, query }, limit: 26, page: 1 },
      timeoutMs,
    );
    const edges = data?.shows?.edges;
    if (!Array.isArray(edges) || edges.length === 0) continue;

    const ranked = edges
      .filter((e: any) => e && e._id)
      .map((e: any) => ({
        id: String(e._id),
        score: scoreMatch(query, String(e.englishName || e.name || '')),
      }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length) return ranked[0].id;
  }
  return null;
}

interface ClockOut {
  streams: Array<{ url: string; quality: string }>;
  subtitles: SubtitleTrack[];
}

/** Resolve one `--`-encoded clock source to its direct links. */
async function resolveClock(sourceUrl: string, timeoutMs: number): Promise<ClockOut> {
  const out: ClockOut = { streams: [], subtitles: [] };
  const path = xor56(sourceUrl.slice(2)).replace('clock', 'clock.json');
  const json = await fetchJson<any>(`${CLOCK_BASE}${path}`, {
    headers: { Referer: `${CLOCK_BASE}/`, 'User-Agent': UA },
    timeoutMs,
  });
  const links = json?.links;
  if (!Array.isArray(links)) return out;

  for (const l of links) {
    if (!l || typeof l.link !== 'string') continue;
    out.streams.push({ url: l.link, quality: String(l.resolution || (l.hls ? 'auto' : '')) });
    const subs = l.subtitles;
    if (Array.isArray(subs)) {
      for (const s of subs) {
        if (s && typeof s.src === 'string') {
          out.subtitles.push({
            url: s.src,
            label: String(s.label || s.lang || 'Subtitle'),
            language: String(s.lang || s.label || 'en'),
            default: s.default === true,
          });
        }
      }
    }
  }
  return out;
}

/** All sources for one translation type (sub|dub). */
async function resolveAudio(
  showId: string,
  episode: number,
  tt: 'sub' | 'dub',
  timeoutMs: number,
): Promise<SourceResult[]> {
  const data = await gql(
    EPISODE_QUERY,
    { showId, translationType: tt, episodeString: String(episode) },
    timeoutMs,
  );
  const sourceUrls = data?.episode?.sourceUrls;
  if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) return [];

  const audioLanguage = tt === 'dub' ? 'en' : 'ja';
  const language = tt === 'dub' ? 'English' : 'Japanese';
  const out: SourceResult[] = [];
  const seen = new Set<string>();

  for (const s of sourceUrls) {
    if (!s || typeof s.sourceUrl !== 'string') continue;
    const name = slug(String(s.sourceName || 'src'));

    if (s.sourceUrl.indexOf('--') === 0) {
      const { streams, subtitles } = await resolveClock(s.sourceUrl, timeoutMs);
      for (const st of streams) {
        if (!/^https?:\/\//i.test(st.url) || seen.has(st.url)) continue;
        seen.add(st.url);
        const origin = originOf(st.url);
        out.push({
          source: `mkissa-${name}-${tt}`,
          url: st.url,
          quality: normalizeQuality(st.quality),
          headers: { Referer: `${CLOCK_BASE}/`, 'User-Agent': UA, ...(origin ? { Origin: origin } : {}) },
          subtitles,
          audioLanguage,
          language,
          sourceType: detectSourceType(st.url),
          providerName: 'MKissa',
          providerKey: 'mkissa',
          server: `mkissa-${name}-${tt}`,
        });
      }
    } else if (/^https?:\/\//i.test(s.sourceUrl) && !seen.has(s.sourceUrl)) {
      // Third-party embed page — pull a direct m3u8/mp4 out of it when possible,
      // otherwise pass the embed through for the app's webview resolver.
      seen.add(s.sourceUrl);
      const res = await resolveToDirectOrEmbed(s.sourceUrl, `${SITE_ORIGIN}/`);
      if (!res) continue;
      const origin = originOf(res.url);
      const headers =
        res.url !== s.sourceUrl && res.headers
          ? { 'User-Agent': UA, ...res.headers }
          : { Referer: `${SITE_ORIGIN}/`, 'User-Agent': UA, ...(origin ? { Origin: origin } : {}) };
      out.push({
        source: `mkissa-${name}-${tt}`,
        url: res.url,
        quality: normalizeQuality(res.quality ?? ''),
        headers,
        subtitles: [],
        audioLanguage,
        language,
        sourceType: res.sourceType,
        providerName: 'MKissa',
        providerKey: 'mkissa',
        server: `mkissa-${name}-${tt}`,
      });
    }
  }
  return out;
}

const provider: StreamProvider = {
  name: 'mkissa',
  // API hosts first (what resolution calls), then the public site + clock host.
  sites: [...API_HOSTS, SITE_ORIGIN, CLOCK_BASE],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const episode = opts.episode ?? 1;
      const timeoutMs = Math.max(5000, Math.min(15000, opts.providerOptions?.timeoutMs ?? 12000));

      const showId = await findShowId(opts.titles, timeoutMs);
      if (!showId) return [];

      const [sub, dub] = await Promise.all([
        resolveAudio(showId, episode, 'sub', timeoutMs),
        resolveAudio(showId, episode, 'dub', timeoutMs),
      ]);
      return [...sub, ...dub];
    } catch {
      return [];
    }
  },

  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    return provider.single({ ...opts, episode: opts.episode ?? 1 });
  },
};

export default provider;
