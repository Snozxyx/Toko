/**
 * AnimeVOSTFR — French VOSTFR catalogue (animevostfr.org), a WordPress site on
 * the ToroPlay theme.
 *
 * Ported from temp/French/French/src/animevostfr. ToroPlay never puts a player
 * URL on the episode page: each tab holds an internal iframe pointing at
 * `?trembed=N&trid=…&trtype=2`, and that page holds the real host iframe. Every
 * server therefore costs two requests, so tabs are peeled and resolved one at a
 * time and the loop stops as soon as enough streams play.
 *
 * Episode URLs are the other awkward part. The theme emits several shapes
 * (`…-1-episode-1`, `…-saison-1-episode-01`, `…-episode-1`, `…-ep-1`), listing is
 * newest-first on some entries and oldest-first on others, and a few entries only
 * put the number in the link text. Hence the pattern ladder tried forwards then
 * backwards, with a guard that rejects a link whose embedded season number
 * disagrees with the one asked for — the exception being an absolute-episode
 * lookup, where the site's flat numbering is expected not to line up.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  toStream,
  resolveEmbedStreams,
  absoluteUrl,
  deaccent,
  countExtraWords,
  stripSeasonSuffix,
  isAborted,
  isBudgetExhausted,
  FR_ACCEPT_LANGUAGE,
} from '../shared.js';

const SITE = 'https://animevostfr.org';
const LABEL = 'AnimeVOSTFR';

const SEARCH_TIMEOUT_MS = 10_000;

/** Search titles kept after ordering; each also contributes one shortened form. */
const MAX_BASE_TITLES = 3;

/** Playable streams to gather before abandoning the remaining player tabs. */
const TARGET_STREAMS = 3;

/** Below this the best search hit is noise, and returning nothing beats guessing. */
const MIN_BEST_SCORE = 25;

interface SearchMatch {
  title: string;
  url: string;
}

interface ScoredMatch extends SearchMatch {
  score: number;
}

interface EpisodeLink {
  url: string;
  text: string;
}

interface PlayerEntry {
  src: string;
  serverName: string;
}

/** Site-flavoured comparison form; leading articles are not part of identity. */
function normalizeSearch(value: string): string {
  return deaccent(String(value || '').toLowerCase())
    .replace(/['‘’:!.,?"]/g, '')
    .replace(/\b(?:the|an?)\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPlayerName(url: string): string {
  if (url.includes('sibnet')) return 'Sibnet';
  if (url.includes('vidmoly')) return 'Vidmoly';
  // Voe rotates through disposable domains; this one is the current alias.
  if (url.includes('christopheruntilpoint') || url.includes('voe')) return 'Voe';
  if (url.includes('luluvid')) return 'Luluvid';
  if (url.includes('savefiles')) return 'Savefiles';
  if (url.includes('uqload') || url.includes('oneupload')) return 'Uqload';
  if (url.includes('hgcloud')) return 'HGCloud';
  if (url.includes('dood') || url.includes('ds2play')) return 'Doodstream';
  if (url.includes('myvi') || url.includes('mytv')) return 'MyVi';
  if (url.includes('sendvid')) return 'Sendvid';
  if (url.includes('stape') || url.includes('streamtape')) return 'Streamtape';
  if (url.includes('moon')) return 'Moon';
  return 'Player';
}

/** VOSTFR is checked first because the VF test would also fire on "vostfr". */
function detectLang(url: string, title: string): string {
  const u = url.toLowerCase();
  const t = (title || '').toLowerCase();
  if (/\/animes\/[^/]*-vostfr(?:\/|$)/.test(u) || /\bvostfr\b/.test(t)) return 'VOSTFR';
  if (/\/animes\/[^/]*-vf(?:\/|$)/.test(u) || /\bvf\b/.test(t)) return 'VF';
  if (/\/animes\/[^/]*-vo(?:\/|$)/.test(u) || /\bvo\b/.test(t)) return 'VO';
  return 'VOSTFR';
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Score one search hit against the query.
 *
 * Exact equality is tested before containment on purpose: with both at the same
 * score a stable sort keeps the site's own order, which lists sequels first, and
 * a season-1 lookup would then extract "… Shippuden" instead of "…". The
 * extra-word penalty exists for the same reason.
 */
function scoreHit(hitTitle: string, simplifiedTitle: string, titleWords: string[]): number {
  const n = normalizeSearch(hitTitle);
  if (n === simplifiedTitle) return 200;

  if (simplifiedTitle.length >= 5 && n.includes(simplifiedTitle)) {
    let score = 100;
    const extra = countExtraWords(n, simplifiedTitle);
    if (extra > 0) score -= Math.min(extra * 25, 60);
    return score;
  }

  let score = 0;
  for (const w of titleWords) {
    if (n.includes(w)) score += 20;
  }
  const lenRatio =
    Math.min(n.length, simplifiedTitle.length) / Math.max(n.length, simplifiedTitle.length || 1);
  return Math.round(score * lenRatio);
}

async function searchAnime(title: string, signal: AbortSignal): Promise<SearchMatch[]> {
  const html = await siteFetchText(`${SITE}/?s=${encodeURIComponent(title)}`, {
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
  });
  if (!html) return [];

  const $ = loadHtml(html);
  const results: SearchMatch[] = [];

  const push = (href: string, text: string, altScope: string) => {
    if (!href.includes('/animes/')) return;
    const url = absoluteUrl(href, SITE);
    if (!url) return;
    // The card's image alt is the full French title; the link text is often
    // truncated or is just the episode badge.
    const imgAlt = altScope
      ? $(`a[href="${href}"]`).closest(altScope).find('img').first().attr('alt')
      : undefined;
    const fallback = href.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') || '';
    results.push({ title: imgAlt || text || fallback, url });
  };

  $('.post-title a, .TPost a, .TPostMv a, article a[href*="/animes/"]').each((_i, el) => {
    push($(el).attr('href') || '', $(el).text().trim(), '.TPost, .TPostMv, article');
  });

  // Second tier: the container selectors in this list carry no href of their own
  // and are inert, but `li > a` still catches themes that render results as a
  // plain list, which is why the group is kept.
  if (results.length === 0) {
    $('.content, #main, main, .result-item, li > a[href*="/animes/"]').each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > 2) push($(el).attr('href') || '', text, 'li, div');
    });
  }

  if (results.length === 0) {
    $('a[href*="/animes/"]').each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > 2) push($(el).attr('href') || '', text, '');
    });
  }

  const seen = new Set<string>();
  const unique = results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  if (unique.length === 0) return [];

  const simplifiedTitle = normalizeSearch(title);
  const titleWords = simplifiedTitle.split(/\s+/).filter((w) => w.length > 2);

  const scored: ScoredMatch[] = unique
    .map((r) => ({ ...r, score: scoreHit(r.title, simplifiedTitle, titleWords) }))
    .sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score ?? 0;
  if (bestScore < MIN_BEST_SCORE) return [];

  // Everything within half of the best score stays: a series is often listed
  // once per language, and both entries are wanted.
  const threshold = Math.max(20, bestScore * 0.5);
  return scored.filter((r) => r.score >= threshold).map((r) => ({ title: r.title, url: r.url }));
}

// ── Episode lookup ───────────────────────────────────────────────────────────

function collectEpisodeLinks(html: string): EpisodeLink[] {
  const $ = loadHtml(html);
  const links: EpisodeLink[] = [];
  $('a[href*="/episode/"]').each((_i, el) => {
    const href = absoluteUrl($(el).attr('href') || '', SITE);
    if (!href) return;
    links.push({ url: href, text: $(el).text().trim() });
  });
  return links;
}

function buildUrlPatterns(season: number, episode: number): RegExp[] {
  const epStr = String(episode);
  const epPadded = epStr.padStart(2, '0');
  const seasonPattern = season ? String(season) : '';
  return [
    new RegExp(`-${seasonPattern}-episode-${epStr}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-${seasonPattern}-episode-${epPadded}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-saison-${seasonPattern}-episode-${epStr}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-saison-${seasonPattern}-episode-${epPadded}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-episode-${epStr}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-episode-${epPadded}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-ep-${epStr}(?:-vostfr|-vf|/|$)`, 'i'),
    new RegExp(`-ep-${epPadded}(?:-vostfr|-vf|/|$)`, 'i'),
  ];
}

function buildTextPatterns(episode: number): RegExp[] {
  const epStr = String(episode);
  return [
    new RegExp(`^\\s*Episode\\s+${epStr}\\s*$`, 'i'),
    new RegExp(`^\\s*Ep\\s*${epStr}\\s*$`, 'i'),
    new RegExp(`(?:^|[^0-9])${epStr}(?:$|[^0-9])`),
  ];
}

/**
 * A link whose URL states a different season than the one requested is the wrong
 * episode, however well the number matches — except under an absolute-episode
 * lookup, where the site's numbering is expected to disagree.
 */
function seasonAgrees(url: string, season: number, isAbsolute: boolean): boolean {
  if (isAbsolute) return true;
  const seasonMatch = url.match(/-(?:saison-)?(\d+)-episode-/i);
  if (!seasonMatch) return true;
  return Number.parseInt(seasonMatch[1], 10) === season;
}

function findEpisodeUrl(
  links: EpisodeLink[],
  season: number,
  episode: number,
  isAbsolute: boolean
): string | null {
  const forward = links;
  const reversed = [...links].reverse();

  const byUrl = (list: EpisodeLink[], pattern: RegExp) =>
    list.find((l) => pattern.test(l.url) && seasonAgrees(l.url, season, isAbsolute));
  const byText = (list: EpisodeLink[], pattern: RegExp) =>
    list.find((l) => pattern.test(l.text) && seasonAgrees(l.url, season, isAbsolute));

  for (const pattern of buildUrlPatterns(season, episode)) {
    for (const list of [forward, reversed]) {
      const hit = byUrl(list, pattern);
      if (hit) return hit.url;
    }
  }
  for (const pattern of buildTextPatterns(episode)) {
    for (const list of [forward, reversed]) {
      const hit = byText(list, pattern);
      if (hit) return hit.url;
    }
  }
  return null;
}

// ── Player extraction ────────────────────────────────────────────────────────

function collectPlayerTabs(html: string): PlayerEntry[] {
  const $ = loadHtml(html);

  const serverNames: Record<string, string> = {};
  $('.TPlayerNv li').each((i, el) => {
    const tabId = $(el).attr('data-tplayernv') || $(el).attr('id') || `Opt${i + 1}`;
    serverNames[tabId] = $(el).text().trim() || `Lecteur ${i + 1}`;
  });

  const entries: PlayerEntry[] = [];
  $('.TPlayerTb, .TPlayer .TPlayerTb').each((i, el) => {
    const tabId = $(el).attr('id') || `Opt${i + 1}`;
    const serverName = serverNames[tabId] || `Lecteur ${i + 1}`;
    const iframeSrc = $(el).find('iframe').first().attr('src');
    // Tabs beyond the first are lazy: their src only exists as data-src until the
    // tab is clicked.
    const lazySrc = $(el).find('.lazy-player, [data-src]').first().attr('data-src');
    const src = iframeSrc || lazySrc;
    if (src) entries.push({ src, serverName });
  });

  if (entries.length === 0) {
    $('iframe[src*="trembed"]').each((i, el) => {
      const src = $(el).attr('src');
      if (src) entries.push({ src, serverName: `Lecteur ${i + 1}` });
    });
  }

  return entries;
}

/** Follow one `?trembed=` page to the host iframe it wraps. */
async function peelTrembed(
  entry: PlayerEntry,
  episodeUrl: string,
  signal: AbortSignal
): Promise<string | null> {
  let trembedUrl = entry.src;
  if (trembedUrl.startsWith('/') || trembedUrl.startsWith('?')) trembedUrl = SITE + trembedUrl;
  if (!trembedUrl.startsWith('http')) return null;

  const embedHtml = await siteFetchText(trembedUrl, {
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
    headers: { Referer: episodeUrl },
  });
  if (!embedHtml) return null;

  const $embed = loadHtml(embedHtml);
  let playerSrc =
    $embed('iframe').first().attr('src') || $embed('[data-src]').first().attr('data-src');

  // Some tabs ship the player as a bare script-built URL with no iframe at all;
  // the first off-site absolute URL on the page is that player.
  if (!playerSrc) {
    const extMatch = embedHtml.match(/(?:src|href)=["'](https?:\/\/(?!animevostfr)[^"']+)["']/i);
    if (extMatch) playerSrc = extMatch[1];
  }

  return playerSrc && playerSrc.startsWith('http') ? playerSrc : null;
}

async function extractPlayersFromEpisode(
  episodeUrl: string,
  language: string,
  signal: AbortSignal,
  startTime: number
): Promise<NuvioStream[]> {
  const html = await siteFetchText(episodeUrl, {
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    acceptLanguage: FR_ACCEPT_LANGUAGE,
  });
  if (!html) return [];

  const out: NuvioStream[] = [];
  for (const entry of collectPlayerTabs(html)) {
    if (out.length >= TARGET_STREAMS) break;
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const playerSrc = await peelTrembed(entry, episodeUrl, signal);
    if (!playerSrc) continue;
    if (isAborted(signal) || isBudgetExhausted(startTime)) break;

    const server = `${getPlayerName(playerSrc)} · ${entry.serverName}`;
    const resolved = await resolveEmbedStreams(playerSrc, {
      language,
      providerLabel: LABEL,
      siteUrl: SITE,
      server,
      headers: { Referer: `${SITE}/` },
    });
    out.push(...resolved);
  }
  return out;
}

// ── Extraction ───────────────────────────────────────────────────────────────

const SPINOFF_KEYWORDS = ['vigilantes', 'prelude', 'special', 'ova', 'ona'];

/** French titles first: the catalogue indexes French names, so they match better. */
function orderTitles(titles: string[]): string[] {
  const isFrench = (t: string) => /[àâéèêëîïôùûüçœæ']/i.test(t);
  return [...titles.filter(isFrench), ...titles.filter((t) => !isFrench(t))];
}

/**
 * Query forms to try: each title without its season suffix, plus its leading
 * segment when it is split by a colon or dash — the site frequently catalogues
 * "X: Subtitle" as just "X".
 */
function buildQueries(titles: string[]): string[] {
  const queries: string[] = [];
  for (const t of orderTitles(titles).slice(0, MAX_BASE_TITLES)) {
    const cleanT = stripSeasonSuffix(t);
    queries.push(cleanT);
    const parts = cleanT
      .split(/[:–-]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 5);
    if (parts.length > 0 && parts[0] !== cleanT) queries.push(parts[0]);
  }

  const seen = new Set<string>();
  return queries.filter((t) => {
    const key = t.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  const titles = ctx.titles.filter((t) => Boolean(t));
  if (titles.length === 0) return [];

  const season = ctx.season ?? 1;
  const searchEpisode = ctx.type === 'movie' ? 1 : (ctx.episode ?? 1);
  const targetEpisodes: number[] = [searchEpisode];
  if (
    ctx.type === 'tv' &&
    typeof ctx.absoluteEpisode === 'number' &&
    ctx.absoluteEpisode > 0 &&
    ctx.absoluteEpisode !== searchEpisode
  ) {
    targetEpisodes.push(ctx.absoluteEpisode);
  }

  let matches: SearchMatch[] = [];
  for (const query of buildQueries(titles)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const results = await searchAnime(query, ctx.signal);
    if (results.length > 0) {
      matches = results;
      break;
    }
  }
  if (matches.length === 0) return [];

  // An entry naming the requested season is the better starting point.
  const seasonMarker = `saison ${season}`;
  matches.sort((a, b) => {
    const hasA = a.title.toLowerCase().includes(seasonMarker);
    const hasB = b.title.toLowerCase().includes(seasonMarker);
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    return 0;
  });

  const mainWords = (titles[0] || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const uniqueMatches: SearchMatch[] = [];
  const seenMatchUrls = new Set<string>();
  for (const m of matches) {
    if (seenMatchUrls.has(m.url)) continue;
    seenMatchUrls.add(m.url);
    uniqueMatches.push(m);
  }

  // Films chain through a single entry: a movie has no episode list to disambiguate
  // against, so trying further matches only burns budget on unrelated pages.
  const matchesToProcess = ctx.type === 'movie' ? uniqueMatches.slice(0, 1) : uniqueMatches;

  const streams: NuvioStream[] = [];
  const checkedEpisodeUrls = new Set<string>();

  for (const match of matchesToProcess) {
    if (streams.length >= TARGET_STREAMS) break;
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

    const language = detectLang(match.url, match.title);
    const matchLower = `${match.title} ${match.url}`.toLowerCase();

    // A side story sharing none of the main title's words is a different show.
    const isSpinoff =
      SPINOFF_KEYWORDS.some((k) => matchLower.includes(k)) &&
      !mainWords.some((w) => matchLower.includes(w));
    if (isSpinoff && uniqueMatches.length > 1) continue;

    // Only trust a season marker in the title when there is no absolute-episode
    // alternative left to try.
    const seasonMatchText = matchLower.match(/saison\s*(\d+)/);
    if (
      seasonMatchText &&
      Number.parseInt(seasonMatchText[1], 10) !== season &&
      targetEpisodes.length === 1
    ) {
      continue;
    }

    const seriesHtml = await siteFetchText(match.url, {
      signal: ctx.signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
      acceptLanguage: FR_ACCEPT_LANGUAGE,
    });
    if (!seriesHtml) continue;
    const links = collectEpisodeLinks(seriesHtml);

    for (const ep of targetEpisodes) {
      if (streams.length >= TARGET_STREAMS) break;
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;

      let episodeUrl = findEpisodeUrl(links, season, ep, ep !== searchEpisode);
      // A film is a one-entry list, so its single episode link is the film itself.
      if (!episodeUrl && ctx.type === 'movie') episodeUrl = links[0]?.url ?? null;
      if (!episodeUrl || checkedEpisodeUrls.has(episodeUrl)) continue;
      checkedEpisodeUrls.add(episodeUrl);

      streams.push(
        ...(await extractPlayersFromEpisode(episodeUrl, language, ctx.signal, startTime))
      );
    }
  }

  // VF and VOSTFR entries frequently link the same upload; the query string
  // differs per tab, so compare without it.
  const seenUrls = new Set<string>();
  const deduped: NuvioStream[] = [];
  for (const s of streams) {
    if (!s?.url) continue;
    const baseUrl = s.url.split('?')[0];
    if (seenUrls.has(baseUrl)) continue;
    seenUrls.add(baseUrl);
    deduped.push(s);
  }

  return deduped;
}

export const animevostfrsite = createNuvioProvider({
  name: 'animevostfrsite',
  sites: [SITE],
  language: 'fr',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'ja',
});
