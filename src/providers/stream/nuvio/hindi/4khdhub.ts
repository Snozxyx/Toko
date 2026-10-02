/**
 * 4KHDHub — Hindi/Multi-audio WordPress scraper on 4khdhub.one
 *
 * Search strategy: WordPress REST API with tmdbId, fallback to title keyword
 * search. Hubcloud links are extracted and resolved via FSL/workers.dev/r2.dev
 * domain chains. Supports movies and TV series.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  siteFetchHtml,
  isAborted,
  isBudgetExhausted,
  absoluteUrl,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://4khdhub.one';
const LABEL = '4KHDHub';
// Upstream domains manifest (self-heals the main host). The old `Xyr0nX/NGEX`
// manifest 404s, so getMainUrl falls back to SITE until a live manifest exists.
const DOMAINS_URL = 'https://raw.githubusercontent.com/Xyr0nX/NGEX/refs/heads/main/manifest.json';

/** Domains for FSL (fast) stream resolution, in descending priority. */
const FSL_HOSTS = [
  'hub.lotuscdn.club',
  'hub.yummy.monster',
  'hub.odyssey.surf',
  'hub.maverick.lat',
  'cdn.fukggl.buzz',
  'hub.diskcdn.buzz',
];

interface WpPost {
  id: number;
  link: string;
  title?: { rendered: string };
  slug?: string;
}

interface ArchiveLink {
  url: string;
  label: string;
  quality: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseQualityHint(text: string): string {
  const t = String(text || '').toLowerCase();
  if (/2160p|4k|uhd/.test(t)) return '2160p';
  if (/1440p|2k/.test(t)) return '1440p';
  if (/1080p/.test(t)) return '1080p';
  if (/720p/.test(t)) return '720p';
  if (/480p/.test(t)) return '480p';
  return 'HD';
}

function inferLanguage(text: string): string {
  const t = String(text || '').toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi')) langs.push('Hindi');
  if (t.includes('tamil')) langs.push('Tamil');
  if (t.includes('telugu')) langs.push('Telugu');
  if (t.includes('english') || /\beng\b/.test(t)) langs.push('English');
  if (t.includes('malayalam')) langs.push('Malayalam');
  if (t.includes('kannada')) langs.push('Kannada');
  if (t.includes('bengali')) langs.push('Bengali');
  if (langs.length > 2) return 'MULTI';
  if (langs.length === 2) return 'DUAL';
  if (langs.length === 1) return langs[0].toUpperCase();
  if (t.includes('dual')) return 'DUAL';
  if (t.includes('multi')) return 'MULTI';
  return 'HINDI';
}

function isHubcloudUrl(url: string): boolean {
  const u = String(url || '').toLowerCase();
  return u.includes('hubcloud') || u.includes('hubdrive') || u.includes('hubcdn') || u.includes('hblinks');
}

function isTrustedDirect(url: string): boolean {
  const u = String(url || '').toLowerCase();
  if (/\.(mkv|mp4|m3u8)(\?|#|$)/.test(u)) return true;
  if (u.includes('.r2.dev/')) return true;
  if (u.includes('.workers.dev/')) return true;
  for (const host of FSL_HOSTS) {
    if (u.includes(host)) return true;
  }
  if (u.includes('video-downloads.googleusercontent.com/')) return true;
  return false;
}

function decodeBase64Safe(value: string): string {
  try {
    const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } };
    if (g.Buffer) return g.Buffer.from(value, 'base64').toString('binary');
    return atob(value);
  } catch {
    return '';
  }
}

function rot13(value: string): string {
  return String(value || '').replace(/[A-Za-z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// ── Domain resolution ────────────────────────────────────────────────────────

let cachedMainUrl: string | null = null;
let cachedMainUrlTs = 0;
const MAIN_URL_TTL = 30 * 60 * 1000;

async function getMainUrl(signal: AbortSignal | null): Promise<string> {
  const now = Date.now();
  if (cachedMainUrl && now - cachedMainUrlTs < MAIN_URL_TTL) return cachedMainUrl;

  try {
    const manifest = await siteFetchJson<Record<string, string>>(DOMAINS_URL, {
      signal,
      timeoutMs: 8_000,
    });
    const fromManifest = manifest?.['4khdhub'] ?? manifest?.['n4khdhub'] ?? '';
    if (fromManifest) {
      cachedMainUrl = fromManifest;
      cachedMainUrlTs = now;
      return fromManifest;
    }
  } catch {
    // fall through
  }
  cachedMainUrl = SITE;
  cachedMainUrlTs = now;
  return SITE;
}

// ── Content search ───────────────────────────────────────────────────────────

async function findPostByTmdbId(
  tmdbId: string,
  mainUrl: string,
  signal: AbortSignal | null
): Promise<string | null> {
  const apiUrl = `${mainUrl}/wp-json/wp/v2/posts?search=${encodeURIComponent(tmdbId)}&per_page=5`;
  const posts = await siteFetchJson<WpPost[]>(apiUrl, { signal, timeoutMs: 10_000 });
  if (posts && posts.length > 0 && posts[0].link) return posts[0].link;
  return null;
}

async function findPostByTitle(
  title: string,
  mainUrl: string,
  isMovie: boolean,
  signal: AbortSignal | null
): Promise<string | null> {
  const searchUrl = `${mainUrl}/?s=${encodeURIComponent(title)}`;
  const html = await siteFetchHtml(searchUrl, {
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal,
    timeoutMs: 12_000,
  });
  if (!html) return null;

  const results: Array<{ url: string; title: string }> = [];

  html('a[href]').each((_, el) => {
    const href = html(el).attr('href') || '';
    if (!href.startsWith(mainUrl) && !href.startsWith('/')) return;
    const text = (html(el).text() || html(el).attr('title') || '').trim();
    if (!text || text.length < 2) return;
    const isSeriesLink =
      /\bseries\b/i.test(text) ||
      /-series-?\d*/i.test(href) ||
      /\/series\//i.test(href) ||
      /\bseason\s*\d+\b/i.test(text);
    if (isMovie && isSeriesLink) return;
    if (!isMovie && !isSeriesLink) return;
    if (/\/(category|tag|author|page|feed|wp-admin)/i.test(href)) return;
    results.push({ url: absoluteUrl(href, mainUrl), title: text });
  });

  if (results.length === 0) return null;

  const queryNorm = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  results.sort((a, b) => {
    const aNorm = a.title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const bNorm = b.title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const aMatch = aNorm === queryNorm ? 0 : aNorm.includes(queryNorm) ? 1 : 2;
    const bMatch = bNorm === queryNorm ? 0 : bNorm.includes(queryNorm) ? 1 : 2;
    return aMatch - bMatch;
  });

  return results[0]?.url ?? null;
}

// ── Link collection ──────────────────────────────────────────────────────────

function collectLinks(html: ReturnType<typeof siteFetchHtml> extends Promise<infer T> ? NonNullable<T> : never, baseUrl: string): ArchiveLink[] {
  const links: ArchiveLink[] = [];
  const seen = new Set<string>();

  const selectors = [
    'div.download-links a[href]',
    'div.gdlink a[href]',
    'div.dllinks a[href]',
    'div.entry-content p a[href]',
    'div.thecontent p a[href]',
    'div.wp-block-buttons a[href]',
    'p > a[href]',
    'a[href]',
  ];

  for (const sel of selectors) {
    html(sel).each((_, el) => {
      const href = absoluteUrl(html(el).attr('href') || '', baseUrl);
      if (!href || seen.has(href)) return;
      const lower = href.toLowerCase();
      const isRelevant =
        lower.includes('hubcloud') ||
        lower.includes('hubdrive') ||
        lower.includes('hubcdn') ||
        lower.includes('hblinks') ||
        lower.includes('workers.dev') ||
        lower.includes('.r2.dev') ||
        /\.(mp4|mkv|m3u8)(\?|$)/i.test(lower);
      if (!isRelevant) return;
      seen.add(href);
      const parentText = (
        html(el).closest('p, div, li').first().text() ||
        html(el).text() ||
        ''
      ).trim();
      links.push({
        url: href,
        label: parentText,
        quality: parseQualityHint(parentText + ' ' + href),
      });
    });
    if (links.length > 0) break;
  }

  return links;
}

function collectEpisodeLinks(
  html: ReturnType<typeof siteFetchHtml> extends Promise<infer T> ? NonNullable<T> : never,
  baseUrl: string,
  season: number,
  episode: number
): ArchiveLink[] {
  const links: ArchiveLink[] = [];
  const seen = new Set<string>();

  html('div.episodes-list div.season-item').each((_, seasonEl) => {
    const seasonText = html(html(seasonEl)).find('div.episode-number').first().text();
    const sm = seasonText.match(/S(?:eason)?\s*([0-9]+)/i);
    if (!sm || Number(sm[1]) !== season) return;
    html(html(seasonEl)).find('div.episode-download-item').each((__, epEl) => {
      const epText = html(html(epEl)).text();
      const em =
        epText.match(/Episode-?\s*0*([0-9]+)/i) ||
        epText.match(/\bE\s*0*([0-9]+)/i);
      if (!em || Number(em[1]) !== episode) return;
      html(html(epEl)).find('a[href]').each((___, a) => {
        const href = absoluteUrl(html(a).attr('href') || '', baseUrl);
        if (!href || seen.has(href)) return;
        seen.add(href);
        const label = html(html(epEl)).text().trim();
        links.push({ url: href, label, quality: parseQualityHint(label) });
      });
    });
  });

  // Flat fallback
  if (links.length === 0) {
    html('div.episode-download-item').each((_, item) => {
      const text = html(item).text();
      const em =
        new RegExp(`Episode-?\\s*0*${episode}\\b`, 'i').test(text) ||
        new RegExp(`\\bE\\s*0*${episode}\\b`, 'i').test(text);
      if (!em) return;
      html(html(item)).find('a[href]').each((__, a) => {
        const href = absoluteUrl(html(a).attr('href') || '', baseUrl);
        if (!href || seen.has(href)) return;
        seen.add(href);
        const label = html(item).text().trim();
        links.push({ url: href, label, quality: parseQualityHint(label) });
      });
    });
  }

  return links;
}

// ── Hubcloud resolution ──────────────────────────────────────────────────────

async function resolveRedirectLinks(url: string, signal: AbortSignal | null): Promise<string> {
  const REDIRECT_REGEX = /s\('o','([A-Za-z0-9+/=]+)'\)|ck\('_wp_http_\d+','([^']+)'\)/g;
  const html = await siteFetchText(url, { signal, timeoutMs: 10_000 });
  if (!html) return '';
  let combined = '';
  let match: RegExpExecArray | null;
  while ((match = REDIRECT_REGEX.exec(html)) !== null) {
    combined += match[1] || match[2] || '';
  }
  if (!combined) return '';
  try {
    const decoded = decodeBase64Safe(rot13(decodeBase64Safe(decodeBase64Safe(combined))));
    const json = JSON.parse(decoded) as { o?: string; data?: string; blog_url?: string };
    const direct = decodeBase64Safe(json.o ?? '').trim();
    if (direct) return direct;
    const data = decodeBase64Safe(json.data ?? '');
    const blogUrl = json.blog_url ?? '';
    if (!data || !blogUrl) return '';
    const result = await siteFetchText(`${blogUrl}?re=${encodeURIComponent(data)}`, {
      signal,
      timeoutMs: 8_000,
    });
    return String(result ?? '').trim();
  } catch {
    return '';
  }
}

async function resolveHubcloud(
  url: string,
  referer: string,
  quality: string,
  langHint: string,
  signal: AbortSignal | null
): Promise<NuvioStream[]> {
  const html = await siteFetchHtml(url, {
    headers: { Referer: referer },
    signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const rawDownload =
    html('#download').attr('href') ||
    html(`a[href*="hubcloud"]`).attr('href') ||
    html(`iframe[src*="hubcloud"]`).attr('src') ||
    '';
  const entryUrl = absoluteUrl(rawDownload, url);
  if (!entryUrl) return [];

  const entryHtml = await siteFetchHtml(entryUrl, {
    headers: { Referer: url },
    signal,
    timeoutMs: 12_000,
  });
  if (!entryHtml) return [];

  const headerText = entryHtml('.card-header').text().trim();
  const resolvedQuality = parseQualityHint(headerText || quality);
  const size =
    entryHtml('#size').text().trim() ||
    (headerText.match(/\d+(?:\.\d+)?\s*(?:GB|MB)/i)?.[0] ?? '');

  const language = inferLanguage(langHint + ' ' + headerText);
  const streams: NuvioStream[] = [];

  entryHtml('a.btn').each((_, el) => {
    const link = absoluteUrl(entryHtml(el).attr('href') || '', entryUrl);
    if (!link) return;
    if (isTrustedDirect(link)) {
      streams.push({
        url: link,
        name: `${LABEL} | ${resolvedQuality}${size ? ` | ${size}` : ''}`,
        title: `[${language}] ${LABEL} · ${resolvedQuality}${size ? ` · ${size}` : ''}`,
        quality: resolvedQuality,
        language,
        headers: {
          Referer: `${entryUrl}/`,
          'User-Agent': NUVIO_UA,
        },
      });
    }
  });

  return streams;
}

async function resolveLink(
  rawUrl: string,
  referer: string,
  quality: string,
  langHint: string,
  signal: AbortSignal | null
): Promise<NuvioStream[]> {
  if (!rawUrl) return [];
  const lower = rawUrl.toLowerCase();

  if (lower.includes('hubcloud')) {
    return resolveHubcloud(rawUrl, referer, quality, langHint, signal);
  }

  if (isTrustedDirect(rawUrl)) {
    const language = inferLanguage(langHint);
    return [
      {
        url: rawUrl,
        name: `${LABEL} | ${quality}`,
        title: `[${language}] ${LABEL} · ${quality}`,
        quality,
        language,
        headers: { Referer: referer, 'User-Agent': NUVIO_UA },
      },
    ];
  }

  // Redirect page (hubdrive, hblinks, etc.) — try extracting a redirect
  if (lower.includes('hubdrive') || lower.includes('hblinks')) {
    const redirected = await resolveRedirectLinks(rawUrl, signal);
    if (redirected && isTrustedDirect(redirected)) {
      return resolveLink(redirected, rawUrl, quality, langHint, signal);
    }
  }

  return [];
}

// ── Main extractor ───────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const mainUrl = await getMainUrl(ctx.signal);
  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // 1. Find the post URL
  let postUrl: string | null = null;

  if (ctx.tmdbId) {
    postUrl = await findPostByTmdbId(ctx.tmdbId, mainUrl, ctx.signal);
  }

  if (!postUrl) {
    for (const title of ctx.titles) {
      if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
      postUrl = await findPostByTitle(title, mainUrl, ctx.type === 'movie', ctx.signal);
      if (postUrl) break;
    }
  }

  if (!postUrl || isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // 2. Scrape the post page
  const pageHtml = await siteFetchHtml(postUrl, {
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!pageHtml) return [];

  const isMovie = ctx.type === 'movie';
  const archiveLinks =
    !isMovie && ctx.season != null && ctx.episode != null
      ? collectEpisodeLinks(pageHtml as Parameters<typeof collectEpisodeLinks>[0], postUrl, ctx.season, ctx.episode)
      : collectLinks(pageHtml as Parameters<typeof collectLinks>[0], postUrl);

  if (archiveLinks.length === 0) return [];

  // 3. Resolve streams
  const streams: NuvioStream[] = [];

  for (const item of archiveLinks) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const resolved = await resolveLink(
      item.url,
      postUrl,
      item.quality,
      item.label,
      ctx.signal
    );
    streams.push(...resolved);

    if (streams.length >= 6) break;
  }

  return streams;
}

export const fourkhdHub = createNuvioProvider({
  name: '4khdhub',
  sites: [SITE],
  language: 'hi',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
