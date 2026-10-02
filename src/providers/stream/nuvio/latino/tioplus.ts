/**
 * TioPlus — Latin American streaming site at tioplus.app.
 *
 * Ported from temp/Latino/Latino/providers/tioplus.js.
 * Search results are article cards; each card links to a content page. The
 * content page has server links that are base64-encoded: each is passed to
 * /player/BASE64 which redirects to the actual embed URL via JS `location.href`.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  loadHtml,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  normalize,
  pickEpisodeHref,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://tioplus.app';
const LABEL = 'TioPlus';

async function getRedirectUrl(serverEncoded: string, referer: string, ctx: NuvioContext): Promise<string | null> {
  const b64 = btoa(serverEncoded);
  const playerUrl = `${SITE}/player/${b64}`;

  const html = await siteFetchText(playerUrl, {
    headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' },
    timeoutMs: 8_000,
    signal: ctx.signal,
    noBypass: true,
  });
  if (!html) return null;

  const match = html.match(/(?:window\.)?location\.href\s*=\s*['"]([^'"]+)['"]/i);
  return match ? match[1] : null;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const searchHtml = await siteFetchText(
    `${SITE}/search/${encodeURIComponent(ctx.titles[0].split(/[:(]/)[0].trim())}`,
    {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!searchHtml || isAborted(ctx.signal)) return [];

  const $ = loadHtml(searchHtml);
  const normQ = normalize(ctx.titles[0]);
  const candidates: Array<{ url: string; title: string }> = [];

  $('article.item a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const title = $(el).find('h2').text().trim() || $(el).text().trim();
    if (href && title) candidates.push({ url: href, title });
  });

  if (candidates.length === 0) return [];

  // Pick best match
  const best = candidates.find(c => normalize(c.title).includes(normQ))
    ?? candidates.find(c => normQ.includes(normalize(c.title)))
    ?? candidates[0];

  let contentUrl = best.url.startsWith('http') ? best.url : `${SITE}${best.url}`;
  let targetUrl = contentUrl;

  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];
    const serieHtml = await siteFetchText(contentUrl, {
      headers: { Referer: `${SITE}/` },
      acceptLanguage: ES_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (serieHtml) {
      const $s = loadHtml(serieHtml);
      const h = pickEpisodeHref($s, ctx.season, ctx.episode);
      if (h) targetUrl = h.startsWith('http') ? h : `${SITE}${h}`;
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

  // Extract base64-encoded server URLs
  const $p = loadHtml(pageHtml);
  const serverUrls: string[] = [];
  const b64Re = /\/player\/([A-Za-z0-9+/=]{10,})/g;
  let m: RegExpExecArray | null;
  while ((m = b64Re.exec(pageHtml)) !== null) {
    try {
      const decoded = atob(m[1]);
      if (decoded.startsWith('http')) serverUrls.push(decoded);
    } catch { /* invalid b64 */ }
  }

  // Also check for direct embed links
  $p('iframe[src]').each((_, el) => {
    const src = $p(el).attr('src');
    if (src?.startsWith('http')) serverUrls.push(src);
  });

  if (serverUrls.length === 0) return [];

  // Resolve redirect pages to final embed URLs
  const resolvedUrls: string[] = [];
  for (const url of serverUrls.slice(0, 6)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const finalUrl = await getRedirectUrl(url, targetUrl, ctx);
    if (finalUrl) resolvedUrls.push(finalUrl);
    else resolvedUrls.push(url);
  }

  if (resolvedUrls.length === 0) return [];

  const embeds = resolvedUrls.map(url => ({ url, language: 'LAT' }));
  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const tioplus = createNuvioProvider({
  name: 'tioplus',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
