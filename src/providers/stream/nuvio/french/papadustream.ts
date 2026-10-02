/**
 * Papadustream — French catalogue whose series pages embed their own HLS
 * playlists instead of delegating to an embed host, so one page fetch yields a
 * directly playable manifest.
 *
 * Ported from temp/French/French/src/papadustream. Two deviations worth naming:
 *
 *   The site keys everything by IMDb id (`/series/tt1234567`). Upstream got that
 *   id from TMDB's `external_ids` endpoint; that call is gone, so the id comes
 *   from the site's own search page, which links straight to `/series/tt…`.
 *
 *   Films sit behind an account wall upstream refused outright. `supportsMovie`
 *   is on here, so the film path does the cheapest possible attempt — find a
 *   film permalink in search results, scan it for a playlist — and returns
 *   nothing when the wall holds, which is the common case.
 *
 * The playlists are multi-variant (360p–1080p) and multi-audio, so a single
 * emitted stream covers every rendition the site has for that episode.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  toStream,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://papadustream.club';
const LABEL = 'Papadustream';

/** Only `.club` carries HLS; `.fr` and `.net` mirror the catalogue without media. */
const SITES = [SITE];

/**
 * Search result permalinks. The site keys series by `/series/{id}` where the id
 * is the IMDb number with a `tt` or (since a 2026 relayout) `mx` prefix — e.g.
 * Game of Thrones moved from `tt0944947` to `mx0944947`. Films still use `tt`.
 */
const SERIES_ID_PATTERN = /\/series\/((?:tt|mx)\d+)/g;
const FILM_ID_PATTERN = /\/(?:films?|movies?)\/(tt\d+)/g;

/** `/hls/s{shard}/serial/{id}/{season}/{episode}/playlist.m3u8` (id tt|mx). */
const SERIAL_HLS_PATTERN =
  /\/hls\/s\d+\/serial\/(?:tt|mx)\d+\/(\d+)\/(\d+)\/playlist\.m3u8/g;

/**
 * Any playlist on a film page.
 *
 * Deliberately not tied to a path shape: the film scheme is unverified (the
 * pages are gated), so a broad scan that finds nothing is preferable to a
 * guessed pattern that silently never matches.
 */
const FILM_HLS_PATTERN = /\/hls\/[^"'\s<>]*playlist\.m3u8/g;

async function fetchPage(
  url: string,
  signal: AbortSignal
): Promise<string | null> {
  return siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal,
    timeoutMs: 10_000,
  });
}

/** Every distinct id a pattern finds on the search page, in document order. */
function collectIds(html: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const regex = new RegExp(pattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    if (!out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

/**
 * Resolve a title to the IMDb id the site uses in its permalinks.
 *
 * Both the bare title and the part before the first colon are tried: the site
 * indexes "Kaguya-sama" but not "Kaguya-sama: Love Is War — Ultra Romantic".
 */
async function findId(
  ctx: NuvioContext,
  pattern: RegExp,
  startTime: number
): Promise<string | null> {
  const queries: string[] = [];
  for (const title of ctx.titles.slice(0, 3)) {
    if (!title) continue;
    if (!queries.includes(title)) queries.push(title);
    const main = title.split(':')[0].trim();
    if (main && main !== title && !queries.includes(main)) queries.push(main);
  }

  for (const query of queries) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const html = await fetchPage(
      `${SITE}/search?q=${encodeURIComponent(query)}`,
      ctx.signal
    );
    if (!html) continue;
    const ids = collectIds(html, pattern);
    if (ids.length > 0) return ids[0];
  }

  return null;
}

/** Playlist paths on a series page matching one season/episode pair. */
function extractHlsUrls(html: string, season: number, episode: number): string[] {
  if (!html) return [];
  const results: string[] = [];
  const regex = new RegExp(SERIAL_HLS_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const epSeason = Number.parseInt(match[1], 10);
    const epNumber = Number.parseInt(match[2], 10);
    if (epSeason === season && epNumber === episode) {
      results.push(`${SITE}${match[0]}`);
    }
  }

  return results;
}

/** `ctx.episode`, then `ctx.absoluteEpisode` — deduped, in that order. */
function episodeCandidates(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [1];
}

function hlsStream(url: string, title: string): NuvioStream {
  const stream = toStream(url, 'VF', LABEL, SITE, { quality: 'HD', title });
  stream.type = 'hls';
  return stream;
}

async function extractMovie(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const imdbId = await findId(ctx, FILM_ID_PATTERN, startTime);
  if (!imdbId) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const html = await fetchPage(`${SITE}/films/${imdbId}`, ctx.signal);
  if (!html) return [];

  const out: NuvioStream[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(FILM_HLS_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    // Series shards leak onto film pages via "related" rails.
    if (match[0].includes('/serial/')) continue;
    const url = `${SITE}${match[0]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(hlsStream(url, `${LABEL} HLS`));
  }
  return out;
}

async function extractSeries(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const imdbId = await findId(ctx, SERIES_ID_PATTERN, startTime);
  if (!imdbId) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const seriesUrl = `${SITE}/series/${imdbId}`;
  let html = await fetchPage(seriesUrl, ctx.signal);
  if (!html) return [];

  // The page is assembled client-side often enough that a first hit can arrive
  // without the playlist block. One retry recovers it; two never helped.
  if (!html.includes('/hls/') || !html.includes('playlist.m3u8')) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
    const retry = await fetchPage(seriesUrl, ctx.signal);
    if (!retry || !retry.includes('playlist.m3u8')) return [];
    html = retry;
  }

  const season = ctx.season ?? 1;
  const episodes = episodeCandidates(ctx);
  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const episode of episodes) {
    if (isAborted(ctx.signal)) break;
    for (const url of extractHlsUrls(html, season, episode)) {
      if (seen.has(url)) continue;
      seen.add(url);
      streams.push(hlsStream(url, `S${season}E${episode} HLS`));
    }
    if (streams.length > 0) break;
  }

  // The site's episode numbering runs one behind the mapping for shows whose
  // first entry is a recap, so the previous episode is worth one look before
  // reporting nothing.
  if (streams.length === 0 && episodes[0] > 1) {
    const previous = episodes[0] - 1;
    for (const url of extractHlsUrls(html, season, previous)) {
      if (seen.has(url)) continue;
      seen.add(url);
      streams.push(hlsStream(url, `S${season}E${previous} HLS (fallback)`));
    }
  }

  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal)) return [];
  return ctx.type === 'movie'
    ? extractMovie(ctx, startTime)
    : extractSeries(ctx, startTime);
}

export const papadustream = createNuvioProvider({
  name: 'papadustream',
  sites: SITES,
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
