/**
 * HDMovie2 — Hindi/Multi-audio streaming site at hdmo2.com.
 *
 * The old `hdmovie2.com.se` host 301-chains through several mirrors
 * (`.com.se`→`.org.uk`→`hdmovie2a.com`→`.net`) and finally lands on `hdmo2.com`,
 * dropping the `?s=` query on the last hop — so point at the `hdmo2.com` terminus
 * directly. Search is bot-gated and only yields results from a real browser.
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/hdmovie2.js.
 * Search by title, get the movie/episode page, extract download/stream links.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  normalize,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://hdmo2.com';
const LABEL = 'HDMovie2';

function inferLangFromTitle(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('multi') || (t.includes('hindi') && t.includes('english'))) return 'MULTI';
  if (t.includes('hindi')) return 'HINDI';
  if (t.includes('tamil')) return 'TAMIL';
  if (t.includes('telugu')) return 'TELUGU';
  return 'HINDI';
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const html = await siteFetchText(
    `${SITE}/?s=${encodeURIComponent(ctx.titles[0])}`,
    {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: HI_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!html || isAborted(ctx.signal)) return [];

  const $ = loadHtml(html);
  const normQ = normalize(ctx.titles[0]);
  let contentUrl: string | null = null;

  $('article a[href]').each((_, el) => {
    if (contentUrl) return;
    const href = $(el).attr('href') ?? '';
    const title = normalize($(el).text().split('(')[0]);
    if (title.includes(normQ) || normQ.includes(title)) contentUrl = href;
  });
  if (!contentUrl) {
    $('article a[href]').first().each((_, el) => { contentUrl = $(el).attr('href') ?? null; });
  }
  if (!contentUrl) return [];

  let targetUrl = contentUrl;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    const serieHtml = await siteFetchText(contentUrl, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: HI_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (serieHtml) {
      const $s = loadHtml(serieHtml);
      let epUrl: string | null = null;
      $s(`a[href*="season-${ctx.season}"][href*="episode-${ctx.episode}"],
          a[href*="s${ctx.season}e${ctx.episode}"],
          a[href*="season${ctx.season}episode${ctx.episode}"]`).each((_, el) => {
        if (!epUrl) epUrl = $s(el).attr('href') ?? null;
      });
      if (epUrl) targetUrl = epUrl;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: { Referer: `${SITE}/` },
    acceptLanguage: HI_ACCEPT_LANGUAGE,
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
      embeds.push({ url: src, language: inferLangFromTitle(src + ' ' + pageHtml.slice(0, 500)) });
    }
  });

  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'HINDI',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const hdmovie2 = createNuvioProvider({
  name: 'hdmovie2',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
