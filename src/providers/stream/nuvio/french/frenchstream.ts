/**
 * Frenchstream — large French catalogue on DataLife Engine, carrying VF, VOSTFR
 * and occasionally VO for both films and series.
 *
 * Ported from temp/French/French/src/frenchstream. The site is unusual in how
 * little of it is HTML:
 *
 *   Series episodes come from two JSON endpoints rather than any page.
 *   `/engine/ajax/get_seasons.php` needs a `serie_tag` of the form `s-XXXXX`
 *   that only exists inside the series page's `#serie-data > .sd-tagz` block, and
 *   the episode map itself is a static JSON file at `/data/eps_<id>.txt` keyed
 *   language → episode → host. Films come from `/engine/ajax/film_api.php`,
 *   keyed the other way round: host → language.
 *
 *   GET search is answered with a 302 to the homepage, so search is a DLE POST
 *   (`do=search&subaction=search&story=…`) to `/index.php`.
 *
 *   Films are not reliably reachable through search at all, so the site's own
 *   category listings are walked and scored by title. Upstream ordered those
 *   categories by TMDB genre; without TMDB the plain listing order is used, and
 *   the early bail-out on a weak best score keeps that from costing much.
 *
 * `film_api.php` returns players for whatever id it is asked about, so a `tagz`
 * of `f-<tmdbId>` is checked before trusting them. That check is skipped when no
 * TMDB id was mapped, since there is then nothing to compare against and the
 * title score is the only signal available.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  normalize,
  countExtraWords,
  stripSeasonSuffix,
  absoluteUrl,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://french-stream.net';
const BASE_URLS = [SITE];
const LABEL = 'Frenchstream';

const MIN_MATCH_SCORE = 60;
const MOVIE_MATCH_SCORE = 55;
const MAX_SEARCH_QUERIES = 3;
/** Embeds resolved per language, so VF and VOSTFR each get their own attempts. */
const MAX_CANDIDATES = 3;
const CATEGORY_FETCH_TIMEOUT = 8_000;
/** Categories probed before the weak-score bail-out. */
const FIRST_CATEGORY_BATCH = 5;
/** Below this the film is almost certainly absent and the walk is abandoned. */
const CATEGORY_BAIL_SCORE = 40;

const ALL_CATEGORIES = [
  '/films/actions/',
  '/films/aventures/',
  '/films/animations/',
  '/films/biopics/',
  '/films/comedies/',
  '/films/drames/',
  '/films/documentaires/',
  '/films/epouvante-horreurs/',
  '/films/historiques/',
  '/films/espionnages/',
  '/films/familles/',
  '/films/fantastiques/',
  '/films/guerres/',
  '/films/policiers/',
  '/films/romances/',
  '/films/science-fictions/',
  '/films/thrillers/',
  '/films/westerns/',
  '/films/vf/',
  '/films/cultes/',
];

/** Query words too common to carry identity, in both French and English. */
const STOP_WORDS = [
  'the', 'and', 'for', 'with', 'from', 'des', 'les', 'une', 'dans', 'sur',
  'via', 'de', 'du', 'la', 'le',
];
const CATEGORY_STOP_WORDS = [...STOP_WORDS, 'das', 'der', 'die'];

interface SearchCard {
  newsId: string;
  href: string;
  title: string;
  isSeries: boolean;
  baseUrl: string;
}

interface RankedCard extends SearchCard {
  score: number;
}

interface SeasonEntry {
  id?: string | number;
  title?: string;
}

/** `/data/eps_<id>.txt`: language → episode number → host → embed URL. */
type EpisodeData = Record<string, Record<string, Record<string, unknown>> | undefined>;

/** `film_api.php`: host → language → embed URL. */
interface FilmApiResponse {
  meta?: { tagz?: string };
  players?: Record<string, Record<string, unknown> | undefined>;
}

interface CategoryMovie {
  newsId: string;
  title: string;
}

interface Candidate {
  url: string;
  language: string;
  server: string;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** The site's internal host keys are abbreviations; these are its display names. */
function hostLabel(key: string): string {
  const host = (key || '').toLowerCase();
  if (host === 'premium') return 'FSVID';
  if (host === 'vidzy') return 'VIDZY';
  if (host === 'uqload') return 'UQLOAD';
  if (host === 'dood') return 'DOOD';
  if (host === 'voe') return 'VOE';
  if (host === 'filmoon') return 'FILEMOON';
  if (host === 'netu') return 'NETU';
  return key ? key.toUpperCase() : 'PLAYER';
}

/** `default` and `vfq` both mean a French dub in this site's vocabulary. */
function languageLabel(key: string): string {
  const lang = (key || '').toLowerCase();
  if (lang === 'vf' || lang === 'default' || lang === 'vfq') return 'VF';
  if (lang === 'vostfr') return 'VOSTFR';
  if (lang === 'vo') return 'VO';
  return lang ? lang.toUpperCase() : 'VF';
}

// ── Search card parsing ──────────────────────────────────────────────────────

/**
 * The DLE post id behind a card, from whichever of four places carries it.
 *
 * The theme has been reskinned repeatedly: newer cards expose it through the
 * info-button's `openModal`, older ones only through the permalink shape.
 */
function pickNewsId(onclick: string, href: string): string | null {
  const modalId = (onclick || '').match(/openModal\('(\d+)'\)/i)?.[1];
  if (modalId) return modalId;

  const newsIdMatch = (href || '').match(/[?&]newsid=(\d+)/i);
  if (newsIdMatch) return newsIdMatch[1];

  const pathMatch = (href || '').match(/^\/(\d+)-/);
  if (pathMatch) return pathMatch[1];

  const numericMatch = (href || '').match(/\/(\d+)(?:-|\/|$)/);
  if (numericMatch) return numericMatch[1];

  return null;
}

function isSeriesCard(
  hasEpisodeBadge: boolean,
  href: string,
  title: string
): boolean {
  if (hasEpisodeBadge) return true;
  const text = `${href || ''} ${title || ''}`;
  return /saison|series|\/s-tv\//i.test(text);
}

/**
 * Cards from a search or listing page.
 *
 * The three selectors are tried in order and the first that yields anything
 * wins: the template nests `.short-in` inside `.short` on some skins and not on
 * others, and matching both would produce every card twice.
 */
function parseSearchCards(html: string, baseUrl: string): SearchCard[] {
  const $ = loadHtml(html);
  const cards: SearchCard[] = [];

  const selectors = ['.short .short-in', '.short-in', '.short'];

  for (const selector of selectors) {
    $(selector).each((_index, element) => {
      const $card = $(element);
      const hrefRaw =
        $card.find('a.short-poster').first().attr('href') ||
        $card.find('a.img-box').first().attr('href') ||
        $card.find('a[href]').first().attr('href') ||
        '';
      const href = absoluteUrl(hrefRaw, baseUrl);
      if (!href) return;

      const title = (
        $card.find('.short-title').first().text() ||
        $card.find('.title').first().text() ||
        $card.find('img').first().attr('alt') ||
        ''
      ).trim();
      if (!title) return;

      const onclick = $card.find('.info-button').attr('onclick') || '';
      const dataId =
        $card.find('[data-id]').first().attr('data-id') || $card.attr('data-id') || '';
      let newsId = pickNewsId(onclick, hrefRaw) || dataId;
      if (!newsId) {
        // The permalink carrying the id is not always the card's first link.
        $card.find('a[href]').each((_i, el) => {
          if (newsId) return;
          newsId = pickNewsId('', $(el).attr('href') || '') || '';
        });
      }
      if (!newsId) return;

      if (cards.some((card) => card.newsId === newsId)) return;

      cards.push({
        newsId,
        href,
        title,
        isSeries: isSeriesCard($card.find('.mli-eps').length > 0, href, title),
        baseUrl,
      });
    });

    if (cards.length > 0) break;
  }

  return cards;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function buildTitleQueries(titles: string[]): string[] {
  const queries: string[] = [];
  const push = (value: string): void => {
    const trimmed = (value || '').trim();
    if (!trimmed) return;
    if (queries.some((q) => q.toLowerCase() === trimmed.toLowerCase())) return;
    queries.push(trimmed);
  };

  for (const title of titles.slice(0, 2)) {
    push(stripSeasonSuffix(title));
    const beforeColon = stripSeasonSuffix(title).split(':')[0];
    if (beforeColon && beforeColon.length >= 3) push(beforeColon);
  }

  return queries.slice(0, MAX_SEARCH_QUERIES);
}

/**
 * Rank a search card against one query.
 *
 * The extra-word penalty deliberately looks at the title only, not the href:
 * DLE permalinks contain `newsid`, `index`, `php` and similar noise that would
 * otherwise be counted as evidence of a fan edit or compilation.
 */
function scoreCard(
  card: SearchCard,
  queryTitle: string,
  mediaType: 'movie' | 'tv',
  season: number | undefined
): number {
  const q = normalize(queryTitle);
  const t = normalize(card.title);
  const hrefN = normalize(card.href || '');
  const hay = `${t} ${hrefN}`.trim();
  if (!q || !t) return 0;

  let score = 0;
  if (t === q) score += 120;
  if (hay.includes(q)) {
    score += 70;
    const extra = countExtraWords(t, q);
    if (extra > 0) score -= Math.min(extra * 25, 55);
  }
  if (q.includes(t)) score += 40;

  const qWords = new Set(
    q.split(' ').filter((w) => w && w.length > 2 && !STOP_WORDS.includes(w))
  );
  const tWords = new Set(hay.split(' ').filter(Boolean));
  let common = 0;
  for (const word of qWords) {
    if (tWords.has(word)) common += 1;
  }
  score += common * 8;

  if (mediaType === 'movie' && card.isSeries) score -= 50;
  if (mediaType === 'tv' && !card.isSeries) score -= 30;

  const sn = Number(season) || 1;
  const text = `${card.title} ${card.href}`.toLowerCase();
  const hasSeason = /saison\s*\d+|s-tv\//i.test(text);
  if (mediaType === 'tv') {
    if (sn > 1) {
      const sr = new RegExp(`saison\\s*${sn}|[-_/]${sn}(?:[^0-9]|$)`, 'i');
      if (sr.test(text)) score += 20;
      if (hasSeason && !sr.test(text)) score -= 25;
    } else if (sn === 1 && /saison\s*[2-9]/i.test(text)) {
      score -= 25;
    }
  }

  return score;
}

function scoreMovieCategory(cardTitle: string, queryTitles: string[]): number {
  const t = normalize(cardTitle);
  if (!t) return 0;

  let bestScore = 0;
  for (const queryTitle of queryTitles) {
    const q = normalize(queryTitle);
    if (!q) continue;

    let score = 0;
    if (t === q) score += 120;
    else if (t.includes(q) || q.includes(t)) score += 70;
    else {
      const qWords = q
        .split(' ')
        .filter((w) => w.length > 2 && !CATEGORY_STOP_WORDS.includes(w));
      const tWords = new Set(t.split(' '));
      let common = 0;
      for (const word of qWords) {
        if (tWords.has(word)) common += 1;
      }
      score += common * 10;
    }

    if (score > bestScore) bestScore = score;
  }
  return bestScore;
}

// ── Site endpoints ───────────────────────────────────────────────────────────

async function fetchPage(
  url: string,
  ctx: NuvioContext,
  timeoutMs: number
): Promise<string | null> {
  return siteFetchText(url, {
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs,
  });
}

async function searchByTitle(
  title: string,
  mediaType: 'movie' | 'tv',
  season: number | undefined,
  ctx: NuvioContext
): Promise<RankedCard[]> {
  const allCards: SearchCard[] = [];

  for (const baseUrl of BASE_URLS) {
    if (isAborted(ctx.signal)) break;
    const html = await siteFetchText(`${baseUrl}/index.php`, {
      form: { do: 'search', subaction: 'search', story: title },
      headers: { Referer: `${baseUrl}/`, Origin: baseUrl },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: 12_000,
    });
    if (html) allCards.push(...parseSearchCards(html, baseUrl));
  }

  const filtered = allCards.filter((card) =>
    mediaType === 'tv' ? card.isSeries : !card.isSeries
  );
  if (filtered.length === 0) return [];

  return filtered
    .map((card) => ({ ...card, score: scoreCard(card, title, mediaType, season) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

/**
 * The `s-XXXXX` tag `get_seasons.php` expects.
 *
 * It is not the TMDB id and not the DLE post id — it is a separate identifier
 * rendered only into the series page's own data block.
 */
function extractSerieTag(html: string): string | null {
  const tagMatch = html.match(/sd-tagz[^>]*>[\s\S]*?(s-[A-Za-z0-9_-]+)/);
  if (tagMatch) return tagMatch[1];
  const dataTagMatch = html.match(/data-tagz=["']([^"']+)/);
  if (dataTagMatch) return dataTagMatch[1];
  return null;
}

async function fetchSeasons(tag: string, ctx: NuvioContext): Promise<SeasonEntry[]> {
  const data = await siteFetchJson<SeasonEntry[]>(
    `${SITE}/engine/ajax/get_seasons.php?serie_tag=${encodeURIComponent(tag)}&news_id=0`,
    {
      headers: { Referer: `${SITE}/`, Origin: SITE },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: 10_000,
    }
  );
  return Array.isArray(data) ? data : [];
}

/**
 * The episode map for one season.
 *
 * The `v` parameter buckets the URL into 30-second windows, which is what the
 * site's own player sends — a bare URL is served from a long-lived edge cache
 * that can predate the season's newest episodes.
 */
async function fetchEpisodeData(
  seasonNewsId: string,
  ctx: NuvioContext
): Promise<EpisodeData | null> {
  return siteFetchJson<EpisodeData>(
    `${SITE}/data/eps_${seasonNewsId}.txt?v=${Math.floor(Date.now() / 30000)}`,
    {
      headers: { Referer: `${SITE}/`, Origin: SITE },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: 10_000,
    }
  );
}

function collectTvSiteCandidates(
  epData: EpisodeData | null,
  episode: number
): Candidate[] {
  const epNum = Number(episode) || 1;
  const out: Candidate[] = [];

  for (const lang of ['vf', 'vostfr', 'vo']) {
    const byEp = epData?.[lang];
    if (!byEp || typeof byEp !== 'object') continue;
    const players = byEp[String(epNum)];
    if (!players || typeof players !== 'object') continue;

    for (const host of Object.keys(players)) {
      const url = players[host];
      if (typeof url === 'string' && url.startsWith('http')) {
        out.push({ url, language: languageLabel(lang), server: hostLabel(host) });
      }
    }
  }

  return out;
}

/**
 * Film players, gated on the post actually being the film that was asked for.
 *
 * `null` distinguishes "this post is something else" from "this post has no
 * players", because only the former makes it worth continuing the search.
 */
async function fetchMoviePlayers(
  newsId: string,
  ctx: NuvioContext
): Promise<Candidate[] | null> {
  const data = await siteFetchJson<FilmApiResponse>(
    `${SITE}/engine/ajax/film_api.php?id=${newsId}`,
    {
      headers: { Referer: `${SITE}/`, Origin: SITE },
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: 10_000,
    }
  );
  if (!data) return null;

  if (ctx.tmdbId) {
    const tagz = data.meta?.tagz || '';
    if (tagz !== `f-${ctx.tmdbId}`) return null;
  }

  const players = data.players;
  if (!players || typeof players !== 'object') return [];

  const out: Candidate[] = [];
  for (const host of Object.keys(players)) {
    const versions = players[host];
    if (!versions || typeof versions !== 'object') continue;
    for (const lang of Object.keys(versions)) {
      const url = versions[lang];
      if (typeof url === 'string' && url.startsWith('http')) {
        out.push({ url, language: languageLabel(lang), server: hostLabel(host) });
      }
    }
  }
  return out;
}

function parseCategoryMovies(html: string): CategoryMovie[] {
  const $ = loadHtml(html);
  const movies: CategoryMovie[] = [];

  $('.short').each((_index, element) => {
    const $card = $(element);
    const newsId =
      $card.find('[data-id]').first().attr('data-id') ||
      ($card.find('.info-button').attr('onclick') || '').match(
        /openModal\('(\d+)'\)/
      )?.[1] ||
      '';
    const title = ($card.find('.short-title').first().text() || '').trim();
    if (newsId && title) movies.push({ newsId, title });
  });

  return movies;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve candidates language by language.
 *
 * Bucketing matters: the site lists several VF hosts before the first VOSTFR
 * one, so a single capped pass would consistently return French dubs only and
 * never surface the subtitled version.
 */
async function resolveCandidates(
  candidates: Candidate[],
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const byLanguage = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byLanguage.get(candidate.language);
    if (bucket) bucket.push(candidate);
    else byLanguage.set(candidate.language, [candidate]);
  }

  const out: NuvioStream[] = [];
  for (const [language, bucket] of byLanguage) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const streams = await resolveEmbedsUntil(
      bucket.slice(0, MAX_CANDIDATES).map((candidate) => ({
        url: candidate.url,
        server: candidate.server,
        language,
      })),
      {
        language,
        providerLabel: LABEL,
        siteUrl: SITE,
        signal: ctx.signal,
        target: 2,
        budgetMs: 9_000,
      }
    );
    out.push(...streams);
  }

  return out;
}

// ── Series ───────────────────────────────────────────────────────────────────

/** `ctx.episode`, then `ctx.absoluteEpisode` — deduped, in that order. */
function episodeCandidates(ctx: NuvioContext): number[] {
  const out: number[] = [];
  for (const value of [ctx.episode, ctx.absoluteEpisode]) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : [1];
}

async function streamsFromSeasonId(
  seasonNewsId: string,
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const epData = await fetchEpisodeData(seasonNewsId, ctx);
  if (!epData) return [];

  for (const episode of episodeCandidates(ctx)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const candidates = collectTvSiteCandidates(epData, episode);
    if (candidates.length === 0) continue;
    const streams = await resolveCandidates(candidates, ctx, startTime);
    if (streams.length > 0) return streams;
  }

  return [];
}

interface SeriesLead {
  serieTag: string | null;
  firstSeasonNewsId: string | null;
}

/** Find the series page and lift both identifiers the JSON endpoints need. */
async function findSeriesLead(
  ctx: NuvioContext,
  season: number | undefined,
  startTime: number
): Promise<SeriesLead> {
  const lead: SeriesLead = { serieTag: null, firstSeasonNewsId: null };

  for (const title of buildTitleQueries(ctx.titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const ranked = await searchByTitle(title, 'tv', season, ctx);
    if (ranked.length === 0 || ranked[0].score < MIN_MATCH_SCORE) continue;

    const card = ranked[0];
    const pageHtml = await fetchPage(
      card.href || `${card.baseUrl}/index.php?newsid=${card.newsId}`,
      ctx,
      10_000
    );
    if (!pageHtml) continue;

    lead.serieTag = extractSerieTag(pageHtml);
    const firstSeasonMatch = pageHtml.match(/data-news-id=["']?(\d+)/);
    if (firstSeasonMatch) lead.firstSeasonNewsId = firstSeasonMatch[1];
    if (lead.serieTag) break;
  }

  return lead;
}

async function extractSeries(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const season = ctx.season;
  const lead = await findSeriesLead(ctx, season, startTime);

  let seasons: SeasonEntry[] = [];
  if (lead.serieTag && !isBudgetExhausted(startTime)) {
    seasons = await fetchSeasons(lead.serieTag, ctx);
  }
  // The tag is sometimes just `s-<tmdbId>`, which is worth one guess when the
  // page did not expose it.
  if (seasons.length === 0 && ctx.tmdbId && !isBudgetExhausted(startTime)) {
    seasons = await fetchSeasons(`s-${ctx.tmdbId}`, ctx);
  }

  if (seasons.length === 0 && lead.firstSeasonNewsId) {
    const streams = await streamsFromSeasonId(lead.firstSeasonNewsId, ctx, startTime);
    if (streams.length > 0) return streams;
  }

  if (seasons.length > 0) {
    const sn = Number(season) || 1;
    const target =
      seasons.find((entry) => {
        const match = (entry.title || '').match(/saison\s*(\d+)/i);
        return match !== null && Number.parseInt(match[1], 10) === sn;
      }) || seasons[0];

    if (target?.id !== undefined) {
      const streams = await streamsFromSeasonId(String(target.id), ctx, startTime);
      if (streams.length > 0) return streams;
    }
  }

  // Last resort: re-run search and pull the season id straight off the card's
  // page. This covers series whose `sd-tagz` block is missing entirely.
  for (const title of buildTitleQueries(ctx.titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const ranked = await searchByTitle(title, 'tv', season, ctx);
    if (ranked.length === 0 || ranked[0].score < MIN_MATCH_SCORE) continue;

    const html = await fetchPage(ranked[0].href, ctx, 10_000);
    if (!html) continue;

    const newsId =
      html.match(/data-news-id="(\d+)"/)?.[1] ||
      html.match(/openModal\('(\d+)'\)/)?.[1];
    if (!newsId) continue;

    const streams = await streamsFromSeasonId(newsId, ctx, startTime);
    if (streams.length > 0) return streams;
  }

  return [];
}

// ── Films ────────────────────────────────────────────────────────────────────

async function extractMovie(
  ctx: NuvioContext,
  startTime: number
): Promise<NuvioStream[]> {
  const queries = buildTitleQueries(ctx.titles);

  let searchProducedCards = false;
  for (const title of queries) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

    const ranked = await searchByTitle(title, 'movie', undefined, ctx);
    if (ranked.length === 0) {
      // A first query with no cards at all means search is broken for this
      // film rather than that the title was wrong; further queries add nothing.
      if (!searchProducedCards) break;
      continue;
    }
    searchProducedCards = true;

    if (ranked[0].score < MIN_MATCH_SCORE) continue;
    const candidates = await fetchMoviePlayers(ranked[0].newsId, ctx);
    if (candidates && candidates.length > 0) {
      const streams = await resolveCandidates(candidates, ctx, startTime);
      if (streams.length > 0) return streams;
    }
  }

  // Walk the category listings, scoring every card by title.
  const seenNewsIds = new Set<string>();
  let bestMatch: CategoryMovie | null = null;
  let bestScore = 0;

  const scanCategory = async (path: string): Promise<void> => {
    const html = await siteFetchText(`${SITE}${path}`, {
      acceptLanguage: FR_ACCEPT_LANGUAGE,
      signal: ctx.signal,
      timeoutMs: CATEGORY_FETCH_TIMEOUT,
    });
    if (!html) return;

    for (const movie of parseCategoryMovies(html)) {
      if (seenNewsIds.has(movie.newsId)) continue;
      seenNewsIds.add(movie.newsId);
      const score = scoreMovieCategory(movie.title, ctx.titles);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = movie;
      }
    }
  };

  const firstBatch = ALL_CATEGORIES.slice(0, FIRST_CATEGORY_BATCH);
  for (const path of firstBatch) {
    if (bestScore >= MOVIE_MATCH_SCORE) break;
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    await scanCategory(path);
  }

  const tryBestMatch = async (): Promise<NuvioStream[]> => {
    if (!bestMatch || bestScore < MOVIE_MATCH_SCORE) return [];
    const candidates = await fetchMoviePlayers(bestMatch.newsId, ctx);
    if (!candidates || candidates.length === 0) return [];
    return resolveCandidates(candidates, ctx, startTime);
  };

  const early = await tryBestMatch();
  if (early.length > 0) return early;

  // Nothing in the busiest categories came close, so the film is not indexed
  // here and walking the remaining fifteen listings would only burn the budget.
  if (bestScore < CATEGORY_BAIL_SCORE) return [];

  for (const path of ALL_CATEGORIES.slice(FIRST_CATEGORY_BATCH)) {
    if (bestScore >= MOVIE_MATCH_SCORE) break;
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    await scanCategory(path);
  }

  return tryBestMatch();
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  const startTime = Date.now();
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  return ctx.type === 'tv'
    ? extractSeries(ctx, startTime)
    : extractMovie(ctx, startTime);
}

export const frenchstream = createNuvioProvider({
  name: 'frenchstream',
  sites: BASE_URLS,
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'fr',
});
