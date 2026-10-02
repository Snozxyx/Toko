/**
 * 4kHdHub — Multi-language WordPress site with HubCloud links.
 *
 * Ported from temp/multi-clone/src/providers/hexion.rs.
 * Uses a dynamic base URL from Codeberg. Searches via WP REST JSON. Post HTML
 * contains HubCloud links resolved to FSL CDN URLs. A time-based suffix is
 * appended to FSL/hub.latent/hub.whistle URLs per upstream logic.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  toStream,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const DEFAULT_SITE = 'https://4khdhub.one';
const DOMAINS_URL  = 'https://codeberg.org/eclipsia-404/eclipsia/raw/branch/main/urls.json';
const LABEL = '4kHdHub';

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' };

let cachedBase = DEFAULT_SITE;
let lastRefresh = 0;

async function refreshDomains(signal: AbortSignal): Promise<void> {
  if (Date.now() - lastRefresh < 4 * 3600_000) return;
  const data = await siteFetchJson<{ '4khdhub'?: string }>(DOMAINS_URL, { timeoutMs: 6_000, signal }).catch(() => null);
  if (data?.['4khdhub']) cachedBase = data['4khdhub'];
  lastRefresh = Date.now();
}

interface WpPost {
  link?: string;
  content?: { rendered?: string };
  title?: { rendered?: string };
}

function parseQuality(text: string): string {
  const t = (text ?? '').toUpperCase();
  if (/2160P|4K|UHD/.test(t)) return '2160p';
  if (/1440P|2K/.test(t)) return '1440p';
  if (/1080P/.test(t)) return '1080p';
  if (/720P/.test(t)) return '720p';
  return 'HD';
}

function inferLang(text: string): string {
  const t = text.toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi'))   langs.push('HINDI');
  if (t.includes('tamil'))   langs.push('TAMIL');
  if (t.includes('english')) langs.push('ENGLISH');
  if (langs.length > 1) return 'MULTI';
  return langs[0] ?? 'HINDI';
}

async function resolveHubcloud(hubUrl: string, base: string, ctx: NuvioContext): Promise<NuvioStream[]> {
  const html = await siteFetchText(hubUrl, {
    headers: { ...HEADERS, Referer: `${base}/` }, timeoutMs: 8_000, signal: ctx.signal,
  });
  if (!html) return [];

  const phpMatch = html.match(/href="([^"]*hubcloud\.php[^"]*)"/i);
  if (!phpMatch) return [];
  const phpUrl = phpMatch[1].replace(/&amp;/g, '&');

  const html2 = await siteFetchText(phpUrl, {
    headers: { ...HEADERS, Referer: hubUrl }, timeoutMs: 8_000, signal: ctx.signal,
  });
  if (!html2) return [];

  const streams: NuvioStream[] = [];
  const linkRe = /href="([^"]+)"/g;
  const currentMinute = Math.floor(Date.now() / 60_000) % 60;
  let m: RegExpExecArray | null;

  while ((m = linkRe.exec(html2)) !== null) {
    let url = m[1];
    const lc = url.toLowerCase();

    // Skip junk
    if (lc.includes('pixel.hubcloud') || lc.includes('bzzhr') || lc.includes('pixeldrain')) continue;
    if (url.endsWith('.zip') || url.endsWith('.rar')) continue;
    if (lc.includes('telegram') || lc.includes('tg/')) continue;

    let host = 'other';
    if (lc.includes('cdn.fsl-buckets') || lc.includes('r2.cloudflarestorage') || lc.includes('r2.dev')) {
      host = 'FSL-v2';
    } else if (lc.includes('hub.latent') || lc.includes('hub.whistle')) {
      url = `${url}1${currentMinute}`;
      host = 'FSL';
    } else continue;

    const ctx_before = html2.slice(Math.max(0, m.index - 1000), m.index);
    const q = parseQuality(ctx_before + ' ' + url);
    if (q === '480p') continue;

    streams.push(toStream(url, inferLang(ctx_before), LABEL, base, {
      quality: q,
      headers: { ...HEADERS, Referer: phpUrl },
      server: host,
    }));
  }
  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  await refreshDomains(ctx.signal);
  const base = cachedBase;

  // Try IMDB id search via WP REST
  let posts: WpPost[] = [];

  let imdbId: string | null = ctx.imdbId ?? null;
  if (!imdbId && ctx.tmdbId) {
    const ext = await siteFetchJson<{ imdb_id?: string }>(
      `https://api.themoviedb.org/3/${ctx.type === 'tv' ? 'tv' : 'movie'}/${ctx.tmdbId}/external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = ext?.imdb_id ?? null;
  }

  const q = imdbId ?? ctx.titles[0];
  const data = await siteFetchJson<WpPost[]>(
    `${base}/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=5`,
    { headers: HEADERS, timeoutMs: 8_000, signal: ctx.signal }
  );
  posts = data ?? [];
  if (posts.length === 0) return [];

  const best = posts[0];
  const postHtml = best.content?.rendered;
  if (!postHtml || isAborted(ctx.signal)) return [];

  let content = postHtml;
  if (ctx.type === 'tv' && ctx.season && ctx.episode) {
    // Look for episode-specific section
    const sxeRe = new RegExp(`S0*${ctx.season}[.\\s_-]*E0*${ctx.episode}|Episode\\s*0*${ctx.episode}`, 'i');
    const scopeMatch = content.match(new RegExp(sxeRe.source + '[\\s\\S]{0,3000}', 'i'));
    if (scopeMatch) content = scopeMatch[0];
  }

  const hubRe = /https?:\/\/hubcloud\.[a-z0-9]+\/drive\/[a-z0-9]+/gi;
  const hubUrls = [...new Set([...content.matchAll(hubRe)].map(m => m[0]))].slice(0, 6);
  if (hubUrls.length === 0) return [];

  const streams: NuvioStream[] = [];
  for (const url of hubUrls) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    streams.push(...await resolveHubcloud(url, base, ctx).catch(() => []));
  }
  return streams;
}

export const fourkHdHub = createNuvioProvider({
  name: 'fourkHdHub',
  sites: [DEFAULT_SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
