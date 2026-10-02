/**
 * XuPalace — Latin American streaming site at xupalace.org.
 *
 * Ported from temp/Latino/Latino/providers/xupalace.js.
 * The site is searched by title; content pages have server links in various
 * anchor/button elements. The site primarily uses IMDb IDs for routing, so we
 * first resolve the IMDb id from TMDB. If that fails we fall back to title
 * search on the site itself.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://xupalace.org';
const LABEL = 'XuPalace';

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  // ani.zip usually carries the IMDb id; TMDB (keyless) is the fallback.
  let imdbId: string | null = ctx.imdbId ?? null;
  if (!imdbId && ctx.tmdbId) {
    const ext = await siteFetchJson<{ imdb_id?: string }>(
      `https://api.themoviedb.org/3/${ctx.type === 'tv' ? 'tv' : 'movie'}/${ctx.tmdbId}/external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = ext?.imdb_id ?? null;
  }

  // Search the site
  const query = imdbId ?? ctx.titles[0];
  const html = await siteFetchText(
    `${SITE}/?s=${encodeURIComponent(query)}`,
    {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!html || isAborted(ctx.signal)) return [];

  const $ = loadHtml(html);
  let contentUrl: string | null = null;

  $('article a[href]').first().each((_, el) => {
    contentUrl = $(el).attr('href') ?? null;
  });
  if (!contentUrl) return [];

  let targetUrl = contentUrl;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    const serieHtml = await siteFetchText(contentUrl, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (serieHtml) {
      const $s = loadHtml(serieHtml);
      let epUrl: string | null = null;
      $s(`a[href*="season-${ctx.season}"][href*="episode-${ctx.episode}"],
          a[href*="temporada-${ctx.season}"][href*="capitulo-${ctx.episode}"],
          a[href*="${imdbId}-${ctx.season}x"]`).each((_, el) => {
        if (!epUrl) epUrl = $s(el).attr('href') ?? null;
      });
      if (epUrl) targetUrl = epUrl;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: { Referer: contentUrl },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!pageHtml) return [];

  const $p = loadHtml(pageHtml);
  const embeds: Array<{ url: string; language: string }> = [];
  const seen = new Set<string>();

  // XuPalace uses various embed containers
  $p('iframe[src], .tab-content iframe[src], .server-content iframe[src]').each((_, el) => {
    const src = $p(el).attr('src');
    if (src?.startsWith('http') && !seen.has(src)) {
      seen.add(src);
      embeds.push({ url: src, language: 'LAT' });
    }
  });

  // Also check data-src attributes
  $p('[data-src]').each((_, el) => {
    const src = $p(el).attr('data-src');
    if (src?.startsWith('http') && !seen.has(src)) {
      seen.add(src);
      embeds.push({ url: src, language: 'LAT' });
    }
  });

  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const xupalace = createNuvioProvider({
  name: 'xupalace',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
