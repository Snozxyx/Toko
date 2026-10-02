/**
 * CinemaCity — DLE-powered Latin American streaming site at cinemacity.cc.
 *
 * Ported from temp/Latino/Latino/providers/cinemacity.js.
 * The site runs a DataLife Engine CMS; search is at /?do=search. Results list
 * `div.dar-short_item` cards. The content page embeds players in iframe tags or
 * in `data-src` base64 attributes. We collect all iframes and resolve them.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  normalize,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://cinemacity.cc';
const LABEL = 'CinemaCity';

// DLE search and content pages are public; the port originally shipped a baked-in
// `dle_user_id`/`dle_password` session cookie, but that is a stale credential that
// does nothing once expired. Send only a Referer and let the public pages resolve.
const SITE_HEADERS = {
  'Referer': `${SITE}/`,
};

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const searchHtml = await siteFetchText(
    `${SITE}/?do=search&subaction=search&search_start=0&full_search=0&story=${encodeURIComponent(ctx.titles[0])}`,
    {
      headers: SITE_HEADERS,
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!searchHtml || isAborted(ctx.signal)) return [];

  const $ = loadHtml(searchHtml);
  const normQuery = normalize(ctx.titles[0]);
  let mediaUrl: string | null = null;

  $('div.dar-short_item').each((_, el) => {
    if (mediaUrl) return;
    const anchor = $(el)
      .find('a')
      .filter((_, a) => ($(a).attr('href') ?? '').includes('.html'))
      .first();
    if (!anchor.length) return;
    const foundTitle = normalize(anchor.text().split('(')[0]);
    if (foundTitle === normQuery || foundTitle.includes(normQuery) || normQuery.includes(foundTitle)) {
      mediaUrl = anchor.attr('href') ?? null;
    }
  });

  if (!mediaUrl) return [];
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  let targetUrl = mediaUrl;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    const seriesHtml = await siteFetchText(mediaUrl, {
      headers: SITE_HEADERS,
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (seriesHtml) {
      const $s = loadHtml(seriesHtml);
      let epUrl: string | null = null;
      $s(`a[href*="season-${ctx.season}"][href*="episode-${ctx.episode}"],
          a[href*="temporada-${ctx.season}"][href*="capitulo-${ctx.episode}"]`).each((_, el) => {
        if (!epUrl) epUrl = $s(el).attr('href') ?? null;
      });
      if (epUrl) targetUrl = epUrl;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: SITE_HEADERS,
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!pageHtml) return [];

  const $p = loadHtml(pageHtml);
  const embeds: Array<{ url: string; language: string }> = [];
  const seen = new Set<string>();

  $p('iframe[src]').each((_, el) => {
    const src = $p(el).attr('src');
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

export const cinemacity = createNuvioProvider({
  name: 'cinemacity',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
