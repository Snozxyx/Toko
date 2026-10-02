/**
 * AniList → TMDB mapping via api.ani.zip.
 *
 * Toko speaks AniList: every lookup arrives as an AniList id plus an *absolute*
 * episode number counted from the start of that AniList entry. Every provider
 * ported from the Nuvio repos speaks TMDB: `getStreams(tmdbId, type, season,
 * episode)`. Those two models disagree in a way that a plain id lookup cannot
 * fix, because AniList splits a long-running show into one entry per cour while
 * TMDB/TVDB keep it as a single series with many seasons.
 *
 * Demon Slayer is the worked example. AniList 166240 is the Hashira Training arc
 * and its first episode is "episode 1"; the same episode on TMDB 85937 is
 * S05E01. Asking a TMDB provider for S01E01 would return the wrong arc entirely
 * — silently, with a valid-looking stream.
 *
 * ani.zip solves both halves at once. `mappings.themoviedb_id` gives the series
 * id, and the `episodes` map is keyed by the AniList episode number with each
 * entry carrying the `seasonNumber`/`episodeNumber` it corresponds to upstream.
 * So the conversion is a lookup, not arithmetic, and it stays correct for shows
 * with recaps, specials, or split cours that no offset rule would handle.
 *
 * The response also carries localized titles (`fr`, `es`, `pt-BR`, `ja`, …).
 * Those matter more than they first appear: the French, Latino and Hindi
 * providers all search their sites by localized name, so handing them
 * "L'entraînement des piliers" instead of the romaji title is often the
 * difference between a hit and an empty result.
 */

import { fetchJson } from '../http/fetch.js';

const ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';

/** Raw `mappings` block, as returned by ani.zip. */
export interface AniZipMappings {
  anilist_id?: number;
  themoviedb_id?: string | number | null;
  thetvdb_id?: number | null;
  imdb_id?: string | null;
  mal_id?: number | null;
  kitsu_id?: number | null;
  anidb_id?: number | null;
  animeplanet_id?: string | null;
  /** "TV" | "MOVIE" | "OVA" | "SPECIAL" | … */
  type?: string | null;
}

export interface AniZipEpisode {
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
  tvdbShowId?: number;
  tvdbId?: number;
  title?: Record<string, string>;
  airDate?: string;
  runtime?: number;
}

export interface AniZipResponse {
  titles?: Record<string, string>;
  episodes?: Record<string, AniZipEpisode>;
  episodeCount?: number;
  specialCount?: number;
  mappings?: AniZipMappings;
}

/** What a TMDB-keyed provider needs in order to run. */
export interface TmdbTarget {
  /** TMDB id as a string, or null when ani.zip has no TMDB mapping. */
  tmdbId: string | null;
  /**
   * IMDb id (`tt…`), or null when ani.zip has no IMDb mapping.
   *
   * ani.zip returns this in the same `mappings` block as the TMDB id, so the
   * providers that search by IMDb id (pelisgo, sololatino, xupalace, vegamovies,
   * 4khdhub, vaplayer, vidking) get it for free. Without it they would each have
   * to call TMDB's `/external_ids`, which needs an api_key Toko does not carry.
   */
  imdbId: string | null;
  /** The `type` argument these providers expect. */
  type: 'movie' | 'tv';
  /** TMDB/TVDB season. Undefined for movies. */
  season?: number;
  /** TMDB/TVDB episode within `season`. Undefined for movies. */
  episode?: number;
  /**
   * Episode number counted from the start of the whole series, not the cour.
   *
   * Several sites — anime-ultime, animevost, the fansub-style catalogues — list a
   * long show as one flat run of episodes, so "Shippuden 500" is the only key
   * they know. ani.zip already carries this per episode, so exposing it here
   * saves each provider the arm.haglund.dev + Cinemeta round trips the upstream
   * repos used to derive it.
   */
  absoluteEpisode?: number;
  /**
   * Search titles, best-first: localized for the requested language, then
   * English, romaji, native, and finally whatever the caller supplied.
   */
  titles: string[];
  /** True when season/episode came from ani.zip rather than being assumed. */
  mapped: boolean;
}

export interface ResolveTargetOptions {
  anilistId: number;
  /** Absolute episode number as Toko counts it. Omit for movies. */
  episode?: number;
  /** Caller-supplied titles, used as the fallback search terms. */
  titles?: string[];
  /**
   * Preferred language for localized titles, e.g. 'fr', 'es', 'hi'.
   * A French provider searching a French site wants the French title first.
   */
  language?: string;
}

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: AniZipResponse | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
/** Negative results expire fast — a missing mapping is often just newly added. */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<number, CacheEntry>();
/** Dedupe concurrent lookups: a provider fan-out hits one anime many times over. */
const inflight = new Map<number, Promise<AniZipResponse | null>>();

function readCache(anilistId: number): CacheEntry | null {
  const hit = cache.get(anilistId);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    cache.delete(anilistId);
    return null;
  }
  return hit;
}

function writeCache(anilistId: number, data: AniZipResponse | null): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Drop the oldest fifth rather than one entry, so eviction is amortised
    // instead of running on nearly every insert once the cache is warm.
    const victims = [...cache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, Math.ceil(MAX_CACHE_ENTRIES / 5));
    for (const [key] of victims) cache.delete(key);
  }
  cache.set(anilistId, {
    data,
    expiresAt: Date.now() + (data ? CACHE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

// ── Fetching ─────────────────────────────────────────────────────────────────

/** Fetch and cache the ani.zip record for an AniList id. Null when unmapped. */
export async function fetchAniZipMapping(
  anilistId: number
): Promise<AniZipResponse | null> {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return null;

  const cached = readCache(anilistId);
  if (cached) return cached.data;

  const existing = inflight.get(anilistId);
  if (existing) return existing;

  const task = (async () => {
    const data = await fetchJson<AniZipResponse>(
      `${ANIZIP_ENDPOINT}?anilist_id=${anilistId}`,
      { timeoutMs: 8000 }
    );
    // Treat a response with no mappings block as a miss: ani.zip answers 200
    // with an error object for unknown ids, which would otherwise be cached as
    // a valid mapping and poison every later lookup for that anime.
    const valid = data && typeof data === 'object' && data.mappings ? data : null;
    writeCache(anilistId, valid);
    return valid;
  })().finally(() => {
    inflight.delete(anilistId);
  });

  inflight.set(anilistId, task);
  return task;
}

// ── Title selection ──────────────────────────────────────────────────────────

/**
 * Order ani.zip's title variants for searching, preferred language first.
 *
 * `x-jat` is the romaji title and deliberately ranks above `ja`: most sites
 * index romaji, and a native-script query matches almost nothing outside Japan.
 */
function buildTitleList(
  response: AniZipResponse | null,
  language: string | undefined,
  fallback: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string | undefined | null) => {
    const title = String(value || '').trim();
    if (!title) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(title);
  };

  const titles = response?.titles || {};
  const lang = (language || '').toLowerCase();

  if (lang) {
    push(titles[lang]);
    // Regional variants: 'pt' should also try 'pt-BR', 'zh' → 'zh-Hant'.
    for (const key of Object.keys(titles)) {
      if (key.toLowerCase().startsWith(`${lang}-`)) push(titles[key]);
    }
  }

  push(titles.en);
  push(titles['x-jat']);
  push(titles.ja);

  for (const title of fallback) push(title);

  return out;
}

// ── Episode conversion ───────────────────────────────────────────────────────

/**
 * Map an absolute AniList episode onto its upstream season/episode.
 *
 * Tries the direct key first (ani.zip keys `episodes` by AniList episode
 * number), then scans for a matching `absoluteEpisodeNumber` to cover records
 * where the keys are absolute across the whole series rather than per-entry.
 */
function convertEpisode(
  response: AniZipResponse | null,
  episode: number | undefined
): { season?: number; episode?: number; absoluteEpisode?: number; mapped: boolean } {
  if (episode === undefined || !Number.isFinite(episode)) {
    return { mapped: false };
  }

  const episodes = response?.episodes;
  if (!episodes) return { season: 1, episode, mapped: false };

  const direct = episodes[String(episode)];
  if (direct?.seasonNumber !== undefined && direct.episodeNumber !== undefined) {
    return {
      season: direct.seasonNumber,
      episode: direct.episodeNumber,
      absoluteEpisode: direct.absoluteEpisodeNumber,
      mapped: true,
    };
  }

  for (const entry of Object.values(episodes)) {
    if (
      entry?.absoluteEpisodeNumber === episode &&
      entry.seasonNumber !== undefined &&
      entry.episodeNumber !== undefined
    ) {
      return {
        season: entry.seasonNumber,
        episode: entry.episodeNumber,
        absoluteEpisode: entry.absoluteEpisodeNumber,
        mapped: true,
      };
    }
  }

  // Unmapped: assume season 1 and pass the episode through. Flagged via
  // `mapped: false` so a provider can weigh its confidence, and so a caller
  // debugging a wrong-arc result can tell an assumption from a real mapping.
  return { season: 1, episode, mapped: false };
}

function normalizeType(raw: string | null | undefined): 'movie' | 'tv' {
  const value = String(raw || '').trim().toUpperCase();
  if (value === 'MOVIE') return 'movie';
  return 'tv';
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Resolve everything a TMDB-keyed provider needs from an AniList lookup.
 *
 * Always returns a usable target. When ani.zip has no TMDB id, `tmdbId` is null
 * and the caller is expected to fall back to searching by the returned titles —
 * which is why `titles` is populated even on a total mapping miss.
 */
export async function resolveTmdbTarget(
  options: ResolveTargetOptions
): Promise<TmdbTarget> {
  const fallbackTitles = (options.titles || []).filter(Boolean);
  const response = await fetchAniZipMapping(options.anilistId);

  const mappings = response?.mappings;
  const rawTmdb = mappings?.themoviedb_id;
  const tmdbId =
    rawTmdb === null || rawTmdb === undefined || rawTmdb === ''
      ? null
      : String(rawTmdb);

  const type = normalizeType(mappings?.type);
  const titles = buildTitleList(response, options.language, fallbackTitles);
  const rawImdb = mappings?.imdb_id;
  const imdbId = rawImdb ? String(rawImdb) : null;

  if (type === 'movie') {
    return { tmdbId, imdbId, type: 'movie', titles, mapped: Boolean(tmdbId) };
  }

  const { season, episode, absoluteEpisode, mapped } = convertEpisode(
    response,
    options.episode
  );

  return {
    tmdbId,
    imdbId,
    type: 'tv',
    season,
    episode,
    absoluteEpisode,
    titles,
    mapped: mapped && Boolean(tmdbId),
  };
}

/** Localized titles for an AniList id, preferred language first. Never throws. */
export async function getLocalizedTitles(
  anilistId: number,
  language?: string,
  fallback: string[] = []
): Promise<string[]> {
  const response = await fetchAniZipMapping(anilistId);
  return buildTitleList(response, language, fallback);
}

/** Total episodes ani.zip knows about, or null. Useful for absolute-numbered sites. */
export async function getEpisodeCount(anilistId: number): Promise<number | null> {
  const response = await fetchAniZipMapping(anilistId);
  const count = response?.episodeCount;
  return typeof count === 'number' && count > 0 ? count : null;
}
