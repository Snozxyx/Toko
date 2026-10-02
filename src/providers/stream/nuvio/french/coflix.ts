/**
 * Coflix — French films, series and anime catalogue (mostly VF, some VOSTFR).
 *
 * Ported from temp/French/French/src/coflix.
 *
 * There is no usable search endpoint on the front end, so the site is addressed by
 * constructing its URLs: `/film/<slug>/` for films and `/episode/<slug>-<S>x<E>/`
 * for episodes. Several slug spellings exist per title, which is why a handful of
 * candidates are probed rather than one. WordPress underneath means
 * `/wp-json/wp/v2/posts?search=` is available as a real search, kept as the fallback
 * when every guessed slug 404s.
 *
 * Coflix moves between domains frequently; all five known hosts are tried in
 * order, with the historically reliable one first.
 *
 * Every page embeds a single lecteurvideo.com player, so unlike the other French
 * catalogues there is exactly one server per episode.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  deaccent,
  stripSeasonSuffix,
  countExtraWords,
  normalize,
  siteFetchText,
  siteFetchJson,
  resolveEmbedStreams,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

/** Ordered by reliability; the later hosts are usually dead but occasionally revive. */
const DOMAINS = [
  'https://coflix.esq',
  'https://coflix.boston',
  'https://coflix.to',
  'https://coflix.cymru',
  'https://coflix.fr',
  'https://coflix.blog',
];
const SITE = DOMAINS[0];
const LABEL = 'Coflix';

const PAGE_TIMEOUT_MS = 5_000;
const MAX_MOVIE_TITLES = 2;
const MAX_SERIES_TITLES = 2;
const MAX_SLUG_CANDIDATES = 4;

interface Found {
  url: string;
  lang: string;
}

interface WpPost {
  link?: string;
  slug?: string;
  title?: { rendered?: string };
}

/**
 * Slugify the way this site does.
 *
 * Deliberately not the shared `toSlug`: Coflix *deletes* apostrophes, colons and
 * brackets instead of turning them into separators, so "Re:Zero" becomes "rezero"
 * where the shared helper would produce "re-zero" and miss every page.
 */
function coflixSlug(title: string): string {
  return deaccent(stripSeasonSuffix(title).toLowerCase())
    .replace(/[':!.,?()[\]"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Slug spellings to try for one title.
 *
 * A leading "the-" is dropped as an alternate because the site indexes both forms,
 * and the season variants cover series published as one page per season.
 */
function generateSlugCandidates(title: string, season: number | null): string[] {
  const base = coflixSlug(title);
  const candidates = [base];
  if (base.startsWith('the-')) candidates.push(base.slice(4));
  if (season) {
    candidates.push(`${base}-s${season}`);
    candidates.push(`${base}-saison-${season}`);
  }
  return [...new Set(candidates.filter(Boolean))];
}

/** GET a path from the first domain that answers. */
async function fetchPath(path: string, signal: AbortSignal): Promise<string | null> {
  for (const domain of DOMAINS) {
    if (isAborted(signal)) return null;
    const html = await siteFetchText(`${domain}${path}`, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: PAGE_TIMEOUT_MS,
      signal,
    });
    if (html) return html;
  }
  return null;
}

async function fetchJsonPath<T>(path: string, signal: AbortSignal): Promise<T | null> {
  for (const domain of DOMAINS) {
    if (isAborted(signal)) return null;
    const data = await siteFetchJson<T>(`${domain}${path}`, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      timeoutMs: PAGE_TIMEOUT_MS,
      signal,
    });
    if (data) return data;
  }
  return null;
}

/**
 * Pull the player embed out of a page.
 *
 * The first iframe is the player on a normal page, but the ad frames that
 * sometimes precede it are excluded by name. When the iframe is injected by script
 * rather than served in the markup, the bare lecteurvideo URL or a `data-src`
 * attribute is still present.
 */
function extractIframeUrl(html: string): string | null {
  if (!html) return null;

  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch) {
    let src = iframeMatch[1];
    if (src.startsWith('//')) src = 'https:' + src;
    if (
      src.includes('lecteurvideo.com') ||
      (src.startsWith('http') &&
        !src.includes('youtube') &&
        !src.includes('googlevideo') &&
        !src.includes('googleads'))
    ) {
      return src;
    }
  }

  const lvMatch = html.match(/https:\/\/lecteurvideo\.com\/\?get=[^"'\s]+/);
  if (lvMatch) return lvMatch[0];

  const dataSrcMatch = html.match(/data-src=["']([^"']*lecteurvideo[^"']*)["']/i);
  if (dataSrcMatch) return dataSrcMatch[1];

  return null;
}

/**
 * Work out whether a page is dubbed or subtitled.
 *
 * The site has no structured field for it, so the URL, the document title and the
 * JSON-LD name are checked in that order of trustworthiness before falling back to
 * scanning the whole body. VF is the default because the catalogue is
 * overwhelmingly dubbed and an unmarked page is a dub.
 */
function extractLanguage(html: string, url: string): string {
  if (!html) return 'VF';
  const lower = html.toLowerCase();
  const urlLower = url.toLowerCase();

  if (urlLower.includes('vostfr')) return 'VOSTFR';
  if (urlLower.includes('-vf') || urlLower.includes('/vf/')) return 'VF';

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].toLowerCase();
    if (t.includes('vostfr')) return 'VOSTFR';
    if (t.includes(' vf ') || / vf[^a-z]/.test(t)) return 'VF';
  }

  const jsonLdMatch = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/
  );
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]) as { name?: string; title?: string };
      const name = (ld.name || ld.title || '').toLowerCase();
      if (name.includes('vostfr')) return 'VOSTFR';
      if (name.includes(' vf ')) return 'VF';
    } catch {
      /* malformed JSON-LD is common; fall through */
    }
  }

  if (/vostfr/i.test(lower)) return 'VOSTFR';
  return 'VF';
}

/** Season/episode as the page itself states them, used to reject near-miss slugs. */
function extractEpisodeNumber(
  html: string
): { season: number; episode: number } | null {
  const parse = (value: string): { season: number; episode: number } | null => {
    const m = value.match(/(\d+)x(\d+)/i) || value.match(/[Ss](\d+)[Ee](\d+)/);
    return m
      ? { season: Number.parseInt(m[1], 10), episode: Number.parseInt(m[2], 10) }
      : null;
  };

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const fromTitle = parse(titleMatch[1]);
    if (fromTitle) return fromTitle;
  }

  const jsonLdMatch = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/
  );
  if (jsonLdMatch) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]) as { name?: string };
      return parse(ld.name || '');
    } catch {
      /* malformed JSON-LD is common */
    }
  }
  return null;
}

async function probeMovie(slug: string, signal: AbortSignal): Promise<Found | null> {
  for (const path of [`/film/${slug}/`, `/movie/${slug}/`]) {
    const html = await fetchPath(path, signal);
    // Under 200 characters means an error stub rather than a real page.
    if (!html || html.length <= 200) continue;
    const url = extractIframeUrl(html);
    if (url) return { url, lang: extractLanguage(html, path) };
  }
  return null;
}

async function probeEpisode(
  slug: string,
  season: number,
  episode: number,
  signal: AbortSignal
): Promise<Found | null> {
  const patterns = [
    `${slug}-${season}x${episode}`,
    `${slug}-s${season}e${episode}`,
    `${slug}-saison-${season}-episode-${episode}`,
  ];

  for (const pattern of [...new Set(patterns)]) {
    const path = `/episode/${pattern}/`;
    const html = await fetchPath(path, signal);
    if (!html || html.length <= 100) continue;

    // A slug can collide with a neighbouring episode. An off-by-one is tolerated
    // (the site's own numbering drifts on split seasons) but anything further
    // apart is the wrong episode.
    const pageEp = extractEpisodeNumber(html);
    if (pageEp && Math.abs((pageEp.episode || 0) - episode) > 1) continue;

    const url = extractIframeUrl(html);
    if (url) return { url, lang: extractLanguage(html, path) };
  }
  return null;
}

/**
 * WordPress REST search, used once every guessed slug has failed.
 *
 * The post's own `slug` is what the site actually published under, so it is the
 * most reliable input to the URL patterns.
 */
async function searchViaWpApi(
  query: string,
  type: 'movie' | 'tv',
  season: number | null,
  episode: number | null,
  signal: AbortSignal
): Promise<Found | null> {
  const posts = await fetchJsonPath<WpPost[]>(
    `/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`,
    signal
  );
  if (!Array.isArray(posts) || posts.length === 0) return null;

  for (const post of posts) {
    if (isAborted(signal)) break;
    const slug = post.slug || '';
    const title = (post.title?.rendered || '').toLowerCase();
    const queryLower = query.toLowerCase();
    const isRelevant = title.includes(queryLower) || slug.includes(coflixSlug(query));
    if (!isRelevant) continue;
    // Two or more significant extra words means a recut or derivative upload.
    if (countExtraWords(normalize(title), normalize(queryLower)) >= 2) continue;

    const seriesSlug = slug || coflixSlug(query);
    if (type === 'tv' && season && episode) {
      for (const epPath of [
        `/episode/${seriesSlug}-${season}x${episode}/`,
        `/episode/${seriesSlug}-s${season}e${episode}/`,
      ]) {
        const html = await fetchPath(epPath, signal);
        if (!html || html.length <= 100) continue;
        const url = extractIframeUrl(html);
        if (url) return { url, lang: extractLanguage(html, epPath) };
      }
    }

    const moviePath = `/film/${seriesSlug}/`;
    const html = await fetchPath(moviePath, signal);
    if (!html || html.length <= 200) continue;
    const url = extractIframeUrl(html);
    if (url) return { url, lang: extractLanguage(html, moviePath) };
  }
  return null;
}

async function toStreams(found: Found, signal: AbortSignal): Promise<NuvioStream[]> {
  if (isAborted(signal)) return [];
  return resolveEmbedStreams(found.url, {
    language: found.lang,
    providerLabel: LABEL,
    siteUrl: SITE,
  });
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];

  if (ctx.type === 'movie') {
    for (const title of ctx.titles.slice(0, MAX_MOVIE_TITLES)) {
      for (const slug of generateSlugCandidates(title, null).slice(
        0,
        MAX_SLUG_CANDIDATES
      )) {
        if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
        const found = await probeMovie(slug, ctx.signal);
        if (found) return toStreams(found, ctx.signal);
      }
    }

    const wpResult = await searchViaWpApi(
      ctx.titles[0],
      'movie',
      null,
      null,
      ctx.signal
    );
    return wpResult ? toStreams(wpResult, ctx.signal) : [];
  }

  const targetSeason = ctx.season ?? 1;
  const requested = ctx.episode ?? 1;
  const targets = [ctx.episode, ctx.absoluteEpisode].filter(
    (n): n is number => typeof n === 'number' && n > 0
  );
  const targetEpisodes = [...new Set(targets.length > 0 ? targets : [1])];

  for (const ep of targetEpisodes) {
    for (const title of ctx.titles.slice(0, MAX_SERIES_TITLES)) {
      for (const slug of generateSlugCandidates(title, targetSeason).slice(
        0,
        MAX_SLUG_CANDIDATES
      )) {
        if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
        const found = await probeEpisode(slug, targetSeason, ep, ctx.signal);
        if (found) return toStreams(found, ctx.signal);
      }
    }
  }

  const wpResult = await searchViaWpApi(
    ctx.titles[0],
    'tv',
    targetSeason,
    requested,
    ctx.signal
  );
  return wpResult ? toStreams(wpResult, ctx.signal) : [];
}

export const coflix = createNuvioProvider({
  name: 'coflix',
  sites: DOMAINS,
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
