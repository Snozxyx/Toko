/**
 * HDHub4u — Multi-language streaming site at hdhub4u.free.
 *
 * Ported from temp/multi-clone/src/providers/qyrvaen.rs.
 * Uses a Typesense/Pingora search index. Post HTML contains HubCloud links
 * (hubcloud.[tld]/drive/[id]) resolved to FSL/workers.dev CDN URLs.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  loadHtml,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

// Old `new3.hdhub4u.cl` 301s here; used mainly as sites[] match + post-page
// referer (search runs through search.pingora.fyi, which returns full permalinks).
const DEFAULT_SITE = 'https://new1.hdhub4u.free';
const SEARCH_EP = 'https://search.pingora.fyi/collections/post/documents/search';
const LABEL = 'HDHub4u';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36';
const BLOCKED_SUBS = ['terapiyo232', 'pinajo4039500'];

function isStreamable(url: string): boolean {
  const host = url.toLowerCase().split('//')[1]?.split('/')[0] ?? '';
  if (host.endsWith('.r2.cloudflarestorage.com')) return true;
  if (host.endsWith('.workers.dev')) {
    const sub = host.replace('.workers.dev', '').split('.').pop() ?? '';
    return !BLOCKED_SUBS.includes(sub);
  }
  return false;
}

function parseQuality(text: string): string {
  const t = (text ?? '').toUpperCase();
  if (/2160P|4K|UHD/.test(t)) return '2160p';
  if (/1440P|2K/.test(t)) return '1440p';
  if (/1080P/.test(t)) return '1080p';
  if (/720P/.test(t)) return '720p';
  if (/480P/.test(t)) return '480p';
  return 'HD';
}

function inferLang(text: string): string {
  const t = text.toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi'))   langs.push('HINDI');
  if (t.includes('tamil'))   langs.push('TAMIL');
  if (t.includes('telugu'))  langs.push('TELUGU');
  if (t.includes('english')) langs.push('ENGLISH');
  if (langs.length > 1) return 'MULTI';
  return langs[0] ?? 'HINDI';
}

interface SearchHit {
  document?: {
    id?: string;
    post_title?: string;
    permalink?: string;
    imdb_id?: string;
  };
}

async function resolveHubcloud(
  hubUrl: string,
  referer: string,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const html = await siteFetchText(hubUrl, {
    headers: { 'User-Agent': UA, Referer: referer },
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  const phpMatch = html.match(/href="([^"]*hubcloud\.php[^"]*)"/i);
  if (!phpMatch) return [];
  const phpUrl = phpMatch[1].replace(/&amp;/g, '&');

  const html2 = await siteFetchText(phpUrl, {
    headers: { 'User-Agent': UA, Referer: hubUrl },
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html2) return [];

  const streams: NuvioStream[] = [];
  const linkRe = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html2)) !== null) {
    const url = m[1];
    if (!isStreamable(url)) continue;
    const ctx_slice = html2.slice(Math.max(0, m.index - 300), m.index);
    const q = parseQuality(url + ' ' + ctx_slice);
    const lang = inferLang(ctx_slice);
    streams.push(toStream(url, lang, LABEL, DEFAULT_SITE, {
      quality: q,
      headers: { 'User-Agent': UA, Referer: phpUrl },
    }));
  }
  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  // Typesense search
  const q = encodeURIComponent(ctx.titles[0]);
  const searchData = await siteFetchJson<{ hits?: SearchHit[] }>(
    `${SEARCH_EP}?q=${q}&query_by=post_title&per_page=10`,
    {
      headers: { 'User-Agent': UA },
      acceptLanguage: HI_ACCEPT_LANGUAGE,
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  const hits = searchData?.hits ?? [];
  if (hits.length === 0) return [];

  const best = hits[0].document;
  if (!best?.permalink) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  let targetUrl = best.permalink;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    const postHtml = await siteFetchText(best.permalink, {
      headers: { 'User-Agent': UA },
      timeoutMs: 8_000,
      signal: ctx.signal,
    });
    if (postHtml) {
      const $ = loadHtml(postHtml);
      let epUrl: string | null = null;
      // Look for episode links matching season/episode
      const sxeRe = new RegExp(`S0*${ctx.season}[.\\s_-]*E0*${ctx.episode}`, 'i');
      $('h3 a[href], h4 a[href]').each((_, el) => {
        if (epUrl) return;
        const href = $(el).attr('href') ?? '';
        if (sxeRe.test($(el).text())) epUrl = href;
      });
      if (epUrl) targetUrl = epUrl;
    }
  }

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const pageHtml = await siteFetchText(targetUrl, {
    headers: { 'User-Agent': UA },
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!pageHtml) return [];

  const hubRe = /https?:\/\/hubcloud\.[a-z0-9]+\/drive\/[a-z0-9]+/gi;
  const hubUrls = [...new Set([...pageHtml.matchAll(hubRe)].map(m => m[0]))].slice(0, 6);
  if (hubUrls.length === 0) return [];

  const streams: NuvioStream[] = [];
  for (const url of hubUrls) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const resolved = await resolveHubcloud(url, targetUrl, ctx).catch(() => []);
    streams.push(...resolved);
  }
  return streams;
}

export const hdhub4u = createNuvioProvider({
  name: 'hdhub4u',
  sites: [DEFAULT_SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
