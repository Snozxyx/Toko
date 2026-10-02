/**
 * fireani — German anime streaming SPA (https://fireani.me).
 *
 * The site was rebuilt on a Connect-RPC (gRPC-web) backend; the old REST routes
 * (`/api/anime/search`, `/api/anime/episode`) are gone and now 404. The current
 * API is a Connect service reachable with the JSON codec (POST + JSON body,
 * JSON reply) — verified live against fireani.me:
 *
 *   POST /api.v1.AnimeSearchService/SearchAnimes   {"q":"<query>"}
 *     → { data: [{ id, slug, title, alternateTitles, generes[], imdb, tmdb }] }
 *
 *   POST /api.v1.anime.AnimeService/GetEpisode     {"slug","season","episode"}
 *     → { data: { animeEpisodeLinks: [{ id, link, lang, name }],
 *                 hasGerSub, hasEngSub, hasGerDub }, status }
 *
 * NOTE the request `season`/`episode` are STRING fields (the server rejects
 * numbers). `lang` is one of `ger-dub` | `ger-sub` | `eng-sub`; `name` is the
 * host label (VOE, ProxyPlayerSlow, …). Each link is a distinct server×language,
 * so every one is emitted as its own source. `link` is an embed (voe.sx, or
 * fireani's own `/embed?…` proxy) resolved to a direct m3u8/mp4 when possible,
 * else kept as a webview-resolver fallback.
 *
 * SourceOptions carries no season; fireani watch URLs are season-keyed, so this
 * defaults to season 1.
 */

import { normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { LanguageCapability, SourceOptions, SourceResult, StreamProvider } from '../../types/index.js';
import { fetchJson } from '../../utils/http/fetch.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const BASE = 'https://fireani.me';
const SEARCH_RPC = `${BASE}/api.v1.AnimeSearchService/SearchAnimes`;
const EPISODE_RPC = `${BASE}/api.v1.anime.AnimeService/GetEpisode`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function rpcHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': UA,
    Referer: `${BASE}/`,
    Origin: BASE,
  };
}

/** Connect unary call with the JSON codec. Returns the parsed reply or null. */
async function rpc<T>(endpoint: string, body: unknown, timeoutMs: number): Promise<T | null> {
  return fetchJson<T>(endpoint, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify(body),
    timeoutMs,
  });
}

interface SearchAnime {
  slug?: string;
  title?: string;
  alternateTitles?: string;
}
interface SearchResponse {
  data?: SearchAnime[];
}

interface EpisodeLink {
  id?: number;
  link?: string;
  lang?: string;
  name?: string;
}
interface EpisodeResponse {
  data?: { animeEpisodeLinks?: EpisodeLink[] };
}

/** Map a fireani `lang` tag to an ISO audio code + human label. */
function langFor(lang: string): { audioLanguage: string; language: string; slug: string } {
  switch (lang.toLowerCase()) {
    case 'ger-dub':
      return { audioLanguage: 'de', language: 'German Dub', slug: 'ger-dub' };
    case 'eng-sub':
      return { audioLanguage: 'ja', language: 'English Sub', slug: 'eng-sub' };
    case 'ger-sub':
      return { audioLanguage: 'ja', language: 'German Sub', slug: 'ger-sub' };
    default:
      // Site is German-sub-first; safest default for an unlabelled link.
      return { audioLanguage: 'ja', language: 'German Sub', slug: 'ger-sub' };
  }
}

function slugify(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Find the best-matching catalogue slug for the requested titles. */
async function findSlug(titles: string[], timeoutMs: number): Promise<string | null> {
  for (const query of buildSearchQueries(titles).slice(0, 3)) {
    const payload = await rpc<SearchResponse>(SEARCH_RPC, { q: query }, timeoutMs);
    const list = Array.isArray(payload?.data) ? payload!.data! : [];
    if (list.length === 0) continue;

    let best: { slug: string; score: number } | null = null;
    for (const a of list) {
      if (!a?.slug) continue;
      // alternateTitles is a comma-joined string ("Animes Stream: x, y, …").
      const names = [a.title || '', ...(a.alternateTitles || '').split(',')].map((s) => s.trim());
      const score = Math.max(...names.map((n) => (n ? scoreMatch(query, n) : 0)), 0);
      if (!best || score > best.score) best = { slug: a.slug, score };
    }
    if (best) return best.slug;
  }
  return null;
}

const provider: StreamProvider = {
  name: 'fireani',
  sites: [BASE],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const episode = opts.episode ?? 1;
      const season = 1; // SourceOptions carries no season; fireani is season-keyed.
      const timeoutMs = Math.max(4000, Math.min(12000, opts.providerOptions?.timeoutMs ?? 9000));

      const slug = await findSlug(opts.titles, timeoutMs);
      if (!slug) return [];

      const ep = await rpc<EpisodeResponse>(
        EPISODE_RPC,
        { slug, season: String(season), episode: String(episode) },
        timeoutMs,
      );
      const links = Array.isArray(ep?.data?.animeEpisodeLinks) ? ep!.data!.animeEpisodeLinks! : [];
      if (links.length === 0) return [];

      const out: SourceResult[] = [];
      const seen = new Set<string>();
      for (const l of links) {
        const url = String(l?.link || '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        const { audioLanguage, language, slug: lslug } = langFor(String(l?.lang || ''));
        const server = slugify(l?.name || 'server') || 'server';

        const res = await resolveToDirectOrEmbed(url, `${BASE}/`);
        if (!res) continue;
        if (seen.has(res.url)) continue;
        seen.add(res.url);

        const headers: Record<string, string> =
          res.url !== url && res.headers
            ? { 'User-Agent': UA, ...res.headers }
            : { Referer: `${BASE}/`, Origin: BASE, 'User-Agent': UA };

        const key = `fireani-${server}-${lslug}`;
        out.push({
          source: key,
          url: res.url,
          quality: normalizeQuality(res.quality || ''),
          headers,
          subtitles: [],
          audioLanguage,
          language,
          sourceType: res.sourceType,
          providerName: 'FireAni',
          providerKey: 'fireani',
          server: key,
        });
      }
      return out;
    } catch {
      return [];
    }
  },

  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    return provider.single({ ...opts, episode: opts.episode ?? 1 });
  },

  async getLanguages(): Promise<LanguageCapability[]> {
    return [
      { language: 'de', label: 'German Dub', type: 'audio' },
      { language: 'ja', label: 'German Sub', type: 'subtitle' },
      { language: 'ja', label: 'English Sub', type: 'subtitle' },
    ];
  },
};

export default provider;
