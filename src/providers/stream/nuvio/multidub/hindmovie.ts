/**
 * HindMovie — Multi-language Indian streaming site at hindmovie.icu.
 *
 * Ported from temp/multi-clone/src/providers/vyranel.rs.
 * Searches the WordPress site by TMDB id or title. Post content contains
 * mvlink.blog / hshare.ink / workers.dev links which are followed to get
 * direct CDN stream URLs.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  loadHtml,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://hindmovie.dev';
const LABEL = 'HindMovie';
const MAX_1080P = 3;

const MOBILE_UAS = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

function pickUA(): string {
  return MOBILE_UAS[Date.now() % MOBILE_UAS.length];
}

function parseQuality(text: string): string {
  const t = (text ?? '').toUpperCase();
  if (/2160P|4K|UHD/.test(t)) return '2160p';
  if (/1440|2K/.test(t)) return '1440p';
  if (/1080P/.test(t)) return '1080p';
  if (/720P/.test(t)) return '720p';
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

interface WpPost { id?: number; link?: string; content?: { rendered?: string } }

async function findPost(
  query: string,
  ua: string,
  ctx: NuvioContext
): Promise<{ url: string; html: string } | null> {
  const data = await siteFetchJson<WpPost[]>(
    `${SITE}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=5`,
    { headers: { 'User-Agent': ua }, timeoutMs: 8_000, signal: ctx.signal }
  );
  if (!data?.length) return null;

  const post = data[0];
  const link = post.link;
  const html = post.content?.rendered;
  if (!html || !link) return null;
  return { url: link, html };
}

async function followLink(url: string, ua: string, ctx: NuvioContext): Promise<string | null> {
  const html = await siteFetchText(url, {
    headers: { 'User-Agent': ua, Referer: `${SITE}/` },
    timeoutMs: 7_000,
    signal: ctx.signal,
    noBypass: true,
  });
  if (!html) return null;

  // Check for redirect or direct URL
  const locMatch = html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
  if (locMatch) return locMatch[1];

  const urlParam = html.match(/[?&]url=([^&'"]+)/);
  if (urlParam) return decodeURIComponent(urlParam[1]);

  // Look for workers.dev or hcloud direct links
  const directMatch = html.match(/href="([^"]+\.workers\.dev[^"]+)"/);
  if (directMatch) return directMatch[1];

  return null;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();
  const ua = pickUA();

  let post = ctx.tmdbId
    ? await findPost(ctx.tmdbId, ua, ctx)
    : null;
  if (!post) post = await findPost(ctx.titles[0], ua, ctx);
  if (!post || isAborted(ctx.signal)) return [];

  let content = post.html;

  // For TV, try to narrow to season/episode section
  if (ctx.type === 'tv' && ctx.season) {
    const seasonRe = new RegExp(`Season\\s+${ctx.season}[\\s\\S]{0,3000}`, 'i');
    const seasonMatch = content.match(seasonRe);
    if (seasonMatch) content = seasonMatch[0];
  }

  const streams: NuvioStream[] = [];
  let count1080 = 0;

  // Extract mvlink.blog links
  const mvlinkRe = /href="(https?:\/\/mvlink\.blog\/(?:web\/)?\d+)"/g;
  const hshareRe = /href="(?:https:\/\/hshare\.ink\/\?id=([^"]+)|https:\/\/hshare\.ink\/dl\/([^"]+))"/g;
  const workersRe = /href="([^"]+\.workers\.dev[^"]+)"/g;

  const allLinkMatches = [
    ...[...content.matchAll(mvlinkRe)].map(m => ({ url: m[1], type: 'mvlink' as const })),
    ...[...content.matchAll(hshareRe)].map(m => ({ url: m[1] ? `https://hshare.ink/?id=${m[1]}` : `https://hshare.ink/dl/${m[2]}`, type: 'hshare' as const })),
    ...[...content.matchAll(workersRe)].map(m => ({ url: m[1], type: 'workers' as const })),
  ];

  for (const { url, type } of allLinkMatches.slice(0, 10)) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    if (count1080 >= MAX_1080P) break;

    let finalUrl = url;
    if (type !== 'workers') {
      const resolved = await followLink(url, ua, ctx);
      if (!resolved) continue;
      finalUrl = resolved;
    }

    // Ensure it's a streamable URL
    if (!finalUrl.startsWith('http')) continue;
    const q = parseQuality(url + ' ' + finalUrl);
    const lang = inferLang(content.slice(Math.max(0, content.indexOf(url) - 300), content.indexOf(url)));

    streams.push(toStream(finalUrl, lang, LABEL, SITE, {
      quality: q,
      headers: { 'User-Agent': ua, Referer: `${SITE}/` },
    }));
    if (q === '1080p') count1080++;
  }

  return streams;
}

export const hindmovie = createNuvioProvider({
  name: 'hindmovie',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
