/**
 * Wookafr — French film and series catalogue on a WordPress theme, reachable
 * through five interchangeable domains.
 *
 * Ported from temp/French/French/src/wookafr. What the site actually needs:
 *
 *   Search is `/?s=<title>` and returns `article.moviecard` tiles whose href
 *   distinguishes films (`/streaming/<slug>/`) from series
 *   (`/streaming/series/<slug>/`). When search fails there are two further
 *   routes — the WordPress REST API, and probing the slug directly — because the
 *   theme's search index goes stale while permalinks keep working.
 *
 *   Only the season that renders as `active` ships its episode list in the page.
 *   Any other season has to be pulled from `admin-ajax.php`, which requires a
 *   nonce lifted out of the page's `sm_Public` bootstrap object.
 *
 * Two upstream behaviours were changed on purpose. Domain and title probes run
 * sequentially rather than through `Promise.allSettled`, because five domains
 * hit at once is the burst pattern that earns a Cloudflare challenge. And the
 * slug probe issues a real GET: upstream used `HEAD`, whose empty body its own
 * truthiness check then rejected, so that fallback could never fire.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  toSlug,
  normalize,
  countExtraWords,
  stripSeasonSuffix,
  resolveEmbedStreams,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://wookafr.boston';
const LABEL = 'Wookafr';

const DOMAINS = [
  'https://wookafr.boston',
  'https://wookafr.center',
  'https://wookafr.cymru',
  'https://wookafr.fyi',
  'https://wookafr.bond',
  'https://wookafr.blue',
];

const SELECTORS = {
  SEARCH_CARD: 'article.moviecard',
  SEARCH_LINK: 'figure a[href]',
  SEARCH_IMAGE: 'figure img',
  MOVIE_IFRAME: '#download .videoWrapper iframe',
  MOVIE_IFRAME_FALLBACK: 'iframe[src*="lecteurvideo"]',
  MOVIE_IFRAME_ANY: 'iframe[src*="embed"]',
  SEASON_BUTTON: 'button.btgy[data-season]',
  EPISODE_ITEM: 'div.itlep',
  EPISODE_LINK: 'a[href]',
  EPISODE_TITLE: 'h6.title',
};

const PATTERNS = {
  EPISODE_URL: /\/episodes\/.*-saison-(\d+)-episode-(\d+)\/?$/i,
  SEASON_TITLE: /(\d+)/,
  SM_PUBLIC:
    /sm_Public\s*=\s*\{[^}]*?url\s*:\s*["']([^"']+)["'][^}]*?nonce\s*:\s*["']([^"']+)["']/,
};

/** The theme's own scoring band: a 150-point exact match, 100 for a substring. */
const SCORES = {
  MIN_MATCH: 30,
  EXACT_MATCH: 150,
  STRONG_MATCH: 100,
};

const MAX_SEARCH_TITLES = 2;

interface Candidate {
  url: string;
  title: string;
  isSeries: boolean;
  domain: string;
}

interface SeasonTab {
  id: string;
  title: string;
  isActive: boolean;
}

interface EpisodeLink {
  season: number;
  episode: number;
  link: string;
  title: string;
}

interface WpPost {
  slug?: string;
  title?: { rendered?: string };
}

interface AjaxEpisodeResponse {
  data?: { html?: string };
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Score a tile title against a query using the theme's own bands.
 *
 * Season markers are stripped before the equality test so "One Piece Saison 2"
 * still scores as an exact hit for "One Piece". The final word-overlap branch
 * rejects results sharing fewer than two significant words with a multi-word
 * query — without it "Law & Order" matches "Police in a Pod" on zero words and
 * still clears the minimum.
 */
function scoreMatch(resultTitle: string, searchTitle: string): number {
  const nt = normalize(searchTitle);
  const nr = normalize(resultTitle);
  if (!nt || !nr) return 0;

  const cleanNr = nr.replace(/saison\s*\d+/g, '').replace(/:\s*$/, '').trim();
  const cleanNt = nt.replace(/saison\s*\d+/g, '').replace(/:\s*$/, '').trim();

  if (cleanNr === cleanNt || nr === nt) return SCORES.EXACT_MATCH;

  if (nr.includes(nt) || nt.includes(nr)) {
    const extra = countExtraWords(nr, nt);
    if (extra > 0) {
      return Math.max(
        SCORES.STRONG_MATCH -
          Math.min(extra * 25, SCORES.STRONG_MATCH - SCORES.MIN_MATCH - 5),
        0
      );
    }
    return SCORES.STRONG_MATCH;
  }

  const words = cleanNt.split(/\s+/).filter((w) => w.length > 2);
  const resultWords = new Set(cleanNr.split(/\s+/));
  const matched = words.filter((w) => resultWords.has(w)).length;
  if (words.length > 0) {
    if (words.length >= 2 && matched < 2) return 0;
    return Math.round((matched / words.length) * 50);
  }
  return 0;
}

function bestMatch(items: Candidate[], title: string): Candidate | null {
  let best: Candidate | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = scoreMatch(item.title, title);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return bestScore >= SCORES.MIN_MATCH ? best : null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseSearchResults(html: string, domain: string): Candidate[] {
  const $ = loadHtml(html);
  const results: Candidate[] = [];
  $(SELECTORS.SEARCH_CARD).each((_index, element) => {
    const $card = $(element);
    const link = $card.find(SELECTORS.SEARCH_LINK).first().attr('href');
    const title = ($card.find(SELECTORS.SEARCH_IMAGE).first().attr('alt') || '').trim();
    if (!link || !title) return;
    results.push({
      url: link,
      title,
      isSeries: link.includes('/streaming/series/'),
      domain,
    });
  });
  return results;
}

function parseSeasons(html: string): SeasonTab[] {
  const $ = loadHtml(html);
  const seasons: SeasonTab[] = [];
  $(SELECTORS.SEASON_BUTTON).each((_index, element) => {
    const $button = $(element);
    const id = $button.attr('data-season');
    if (!id) return;
    seasons.push({
      id,
      title: $button.text().trim(),
      isActive: $button.hasClass('active'),
    });
  });
  return seasons;
}

function parseEpisodes(html: string): EpisodeLink[] {
  const $ = loadHtml(html);
  const episodes: EpisodeLink[] = [];
  $(SELECTORS.EPISODE_ITEM).each((_index, element) => {
    const $link = $(element).find(SELECTORS.EPISODE_LINK).first();
    const href = $link.attr('href') || '';
    const title =
      $link.find(SELECTORS.EPISODE_TITLE).first().text().trim() ||
      $link.text().trim();
    const match = href.match(PATTERNS.EPISODE_URL);
    if (!match) return;
    episodes.push({
      season: Number.parseInt(match[1], 10),
      episode: Number.parseInt(match[2], 10),
      link: href,
      title,
    });
  });
  return episodes;
}

function extractNonce(html: string): string | null {
  const match = html.match(PATTERNS.SM_PUBLIC);
  return match ? match[2] : null;
}

/**
 * The player iframe, tried from most to least specific.
 *
 * The final sweep over every iframe is what makes this survive theme updates —
 * the wrapper markup changes, the player host does not. YouTube is excluded
 * because the trailer block sits in the same container as the player.
 */
function extractIframeUrl(html: string): string | null {
  const $ = loadHtml(html);
  let src =
    $(SELECTORS.MOVIE_IFRAME).first().attr('src') ||
    $(SELECTORS.MOVIE_IFRAME_FALLBACK).first().attr('src') ||
    $(SELECTORS.MOVIE_IFRAME_ANY).first().attr('src');

  if (!src) {
    $('iframe').each((_index, element) => {
      if (src) return;
      const candidate = $(element).attr('src');
      if (
        candidate &&
        candidate.startsWith('http') &&
        !candidate.includes('youtube.com') &&
        !candidate.includes('youtu.be')
      ) {
        src = candidate;
      }
    });
  }

  if (src && src.startsWith('//')) src = `https:${src}`;
  return src || null;
}

function detectLanguage(url: string, html: string): string {
  const value = url.toLowerCase();
  if (value.includes('vostfr') || value.includes('vost')) return 'VOSTFR';
  if (value.includes('vf') || value.includes('french')) return 'VF';
  if (value.includes('vo') || value.includes('english')) return 'VO';

  if (html) {
    const pageText = loadHtml(html)('body').text().toLowerCase();
    if (/vostfr|version originale sous-titr[eé]e/i.test(pageText)) return 'VOSTFR';
    if (/version fran[çc]aise/i.test(pageText)) return 'VF';
  }
  return 'VF';
}

function detectQuality(url: string, title: string): string {
  const text = `${url} ${title || ''}`.toLowerCase();
  if (/4k|2160/i.test(text)) return '4K';
  if (/1080|hd|fullhd/i.test(text)) return '1080p';
  if (/720|hd-ready/i.test(text)) return '720p';
  return 'HD';
}

// ── Fetching across the domain pool ──────────────────────────────────────────

interface DomainPage {
  html: string;
  domain: string;
}

/**
 * Fetch a path from the first domain that answers with a real page.
 *
 * `path` may be absolute — search results link to whichever domain served them,
 * and those links must be followed as given.
 */
async function fetchFromPool(
  path: string,
  ctx: NuvioContext,
  timeoutMs: number
): Promise<DomainPage | null> {
  if (/^https?:\/\//i.test(path)) {
    const html = await siteFetchText(path, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs,
    });
    if (!html) return null;
    let origin = SITE;
    try {
      origin = new URL(path).origin;
    } catch {
      /* keep the primary origin */
    }
    return { html, domain: origin };
  }

  for (const domain of DOMAINS) {
    if (isAborted(ctx.signal)) return null;
    const html = await siteFetchText(`${domain}${path}`, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs,
    });
    if (html && html.length > 200) return { html, domain };
  }
  return null;
}

// ── Discovery ────────────────────────────────────────────────────────────────

async function searchCatalogue(
  ctx: NuvioContext,
  wantSeries: boolean,
  startTime: number
): Promise<Candidate | null> {
  const titles = ctx.titles
    .slice(0, MAX_SEARCH_TITLES)
    .map((title) => stripSeasonSuffix(title))
    .filter(Boolean);

  for (const domain of DOMAINS) {
    for (const title of titles) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;

      const html = await siteFetchText(
        `${domain}/?s=${encodeURIComponent(title)}`,
        { acceptLanguage: FR_ACCEPT_LANGUAGE, signal: ctx.signal, timeoutMs: 8_000 }
      );
      if (!html) continue;

      const results = parseSearchResults(html, domain);
      if (results.length === 0) continue;

      // Prefer the right shape, but accept the other rather than returning
      // nothing: the theme files some series under the film permalink.
      const preferred = results.filter((r) => r.isSeries === wantSeries);
      const match =
        bestMatch(preferred.length > 0 ? preferred : results, title) ||
        bestMatch(results, title);
      if (match) return match;
    }
  }

  return null;
}

/** Strip season/packaging suffixes a permalink would not carry. */
function cleanSlug(slug: string): string {
  return slug
    .replace(/-(?:1st|2nd|3rd|4th|5th)-season$/, '')
    .replace(/-(?:season|saison)-?\d+$/, '')
    .replace(/-s\d+$/, '')
    .replace(/-(?:part|cour|arc|volume)-?\d+$/, '')
    .replace(/-(?:tv|film|movie|special)$/, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

async function trySlugFallback(
  ctx: NuvioContext,
  wantSeries: boolean,
  startTime: number
): Promise<Candidate | null> {
  const title = ctx.titles[0];
  if (!title) return null;

  const slug = toSlug(title);
  const cleaned = cleanSlug(slug);
  const season = ctx.season ?? 1;

  const candidates = [
    slug,
    cleaned,
    slug.replace(/-(?:season|saison)-?\d+$/, ''),
    slug.replace(/-\d+(?:st|nd|rd|th)?-season$/, ''),
  ];
  if (season > 1) {
    candidates.push(`${cleaned}-${season}`, `${slug}-${season}`);
  }

  const unique = [...new Set(candidates.filter((value) => value && value.length > 3))];

  for (const value of unique) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;
    const path = wantSeries ? `/streaming/series/${value}/` : `/streaming/${value}/`;
    const page = await fetchFromPool(path, ctx, 5_000);
    // A permalink that exists renders a player; the theme's 404 does not.
    if (page && extractIframeUrl(page.html)) {
      return {
        url: `${page.domain}${path}`,
        title: value.replace(/-/g, ' '),
        isSeries: wantSeries,
        domain: page.domain,
      };
    }
  }

  return null;
}

/**
 * Last resort: ask WordPress for the post, then probe both permalink shapes.
 *
 * The REST index stays current even when the theme's own search returns
 * nothing, which is the failure mode this covers.
 */
async function searchViaWpApi(
  ctx: NuvioContext,
  startTime: number
): Promise<Candidate | null> {
  const query = ctx.titles[0];
  if (!query) return null;

  for (const domain of DOMAINS) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;

    const posts = await siteFetchJson<WpPost[]>(
      `${domain}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`,
      { acceptLanguage: FR_ACCEPT_LANGUAGE, signal: ctx.signal, timeoutMs: 8_000 }
    );
    if (!Array.isArray(posts) || posts.length === 0) continue;

    for (const post of posts) {
      const slug = post.slug || '';
      if (!slug) continue;
      const rendered = (post.title?.rendered || '').toLowerCase();
      const relevant =
        rendered.includes(query.toLowerCase()) || slug.includes(toSlug(query));
      if (!relevant) continue;

      for (const path of [`/streaming/${slug}/`, `/streaming/series/${slug}/`]) {
        if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return null;
        const page = await fetchFromPool(path, ctx, 6_000);
        if (page && extractIframeUrl(page.html)) {
          return {
            url: `${page.domain}${path}`,
            title: post.title?.rendered || slug,
            isSeries: path.includes('/series/'),
            domain: page.domain,
          };
        }
      }
    }
  }

  return null;
}

async function findCandidate(
  ctx: NuvioContext,
  wantSeries: boolean,
  startTime: number
): Promise<Candidate | null> {
  return (
    (await searchCatalogue(ctx, wantSeries, startTime)) ||
    (await trySlugFallback(ctx, wantSeries, startTime)) ||
    (await searchViaWpApi(ctx, startTime))
  );
}

// ── Extraction ───────────────────────────────────────────────────────────────

async function streamsFromPage(
  pageUrl: string,
  html: string,
  title: string
): Promise<NuvioStream[]> {
  const iframeUrl = extractIframeUrl(html);
  if (!iframeUrl) return [];
  const language = detectLanguage(pageUrl, html);
  const quality = detectQuality(iframeUrl, title);
  return resolveEmbedStreams(iframeUrl, {
    language,
    providerLabel: LABEL,
    siteUrl: SITE,
    quality,
  });
}

async function extractMovie(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const match = await findCandidate(ctx, false, startTime);
  if (!match || isBudgetExhausted(startTime)) return [];

  const page = await fetchFromPool(match.url, ctx, 12_000);
  if (!page) return [];
  return streamsFromPage(match.url, page.html, match.title);
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

async function fetchSeasonEpisodes(
  seriesHtml: string,
  season: SeasonTab,
  domain: string,
  ctx: NuvioContext
): Promise<EpisodeLink[]> {
  if (season.isActive) return parseEpisodes(seriesHtml);

  const nonce = extractNonce(seriesHtml);
  if (!nonce) return [];

  const payload = await siteFetchJson<AjaxEpisodeResponse>(
    `${domain}/wp-admin/admin-ajax.php`,
    {
      method: 'POST',
      form: { action: 'getepisodes', season_id: season.id, nonce },
      headers: { Referer: `${domain}/`, Origin: domain },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: 8_000,
    }
  );
  const html = payload?.data?.html;
  return html ? parseEpisodes(html) : [];
}

async function extractSeries(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const targetSeason = ctx.season ?? 1;
  const targetEpisodes = episodeCandidates(ctx);

  const match = await findCandidate(ctx, true, startTime);
  if (!match || isBudgetExhausted(startTime)) return [];

  const page = await fetchFromPool(match.url, ctx, 12_000);
  if (!page) return [];

  const seasons = parseSeasons(page.html);
  if (seasons.length === 0) {
    // Single-season entries render the player straight onto the series page.
    return streamsFromPage(match.url, page.html, match.title);
  }

  const season =
    seasons.find((tab) => {
      const number = tab.title.match(PATTERNS.SEASON_TITLE);
      return number !== null && Number.parseInt(number[1], 10) === targetSeason;
    }) || seasons[0];

  const episodes = await fetchSeasonEpisodes(page.html, season, page.domain, ctx);
  if (episodes.length === 0) return [];

  const inSeason = episodes.filter((entry) => entry.season === targetSeason);
  let episode: EpisodeLink | undefined;
  for (const number of targetEpisodes) {
    episode = inSeason.find((entry) => entry.episode === number);
    if (episode) break;
  }
  // Positional fallback: some seasons are numbered from the series start, so the
  // Nth listed entry is the Nth episode even when the labels disagree.
  if (!episode) episode = inSeason[targetEpisodes[0] - 1];
  if (!episode || isBudgetExhausted(startTime)) return [];

  const episodePage = await fetchFromPool(episode.link, ctx, 12_000);
  if (!episodePage) return [];
  return streamsFromPage(episode.link, episodePage.html, episode.title);
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal)) return [];
  if (ctx.titles.length === 0) return [];
  return ctx.type === 'movie'
    ? extractMovie(ctx, startTime)
    : extractSeries(ctx, startTime);
}

export const wookafr = createNuvioProvider({
  name: 'wookafr',
  sites: DOMAINS,
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
