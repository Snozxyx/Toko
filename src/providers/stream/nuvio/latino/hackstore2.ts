/**
 * HackStore2 — Latin American movie/series site.
 *
 * Ported from temp/Latino/Latino/providers/hackstore2.js.
 * The upstream delegates to an extractor. We implement a generic title-search
 * + iframe-extraction approach.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  pickEpisodeHref,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://hackstore2.com';
const LABEL = 'HackStore2';

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const html = await siteFetchText(
    `${SITE}/?s=${encodeURIComponent(ctx.titles[0])}`,
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

  let targetUrl: string = contentUrl;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    const serieHtml = await siteFetchText(contentUrl, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (serieHtml) {
      const $s = loadHtml(serieHtml);
      const epUrl = pickEpisodeHref($s, ctx.season, ctx.episode);
      if (epUrl) targetUrl = epUrl;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: { Referer: `${SITE}/` },
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

export const hackstore2 = createNuvioProvider({
  name: 'hackstore2',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
