/**
 * WatchAnimeWorld — scraper adapter (https://watchanimeworld.one)
 *
 * Restored 2026-08 on the successor domain. The original `.com`/`.top`/`.net`
 * hosts are gone; the site now lives at `watchanimeworld.one` behind
 * Cloudflare. From a real browser (the extension runtime) requests carry the
 * visitor's CF clearance; from a server the helper detects challenge pages and
 * gives up quickly so the provider stays cheap when blocked.
 *
 * Structure (unchanged from the pre-move site):
 *   Search:   /?s={query}                       (WordPress)
 *   Series:   /series/{slug}/
 *   Episode:  /episode/{slug}-{season}x{episode}/
 *
 * The watch page embeds a base64 (URL-safe alphabet) encoded server list in
 * `player1.php?data=…`; decoded it is JSON:
 *   [{ link|url|file, language, quality }, …]
 * Languages cover the Indian dubs (Hindi/Tamil/Telugu/…) WAW is known for.
 */
import { normalizeQuality, detectSourceType } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { StreamProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { loadHtml } from '../../utils/http/fetch.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';

const BASES = ['https://watchanimeworld.one'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Language name map used by WAW's player1.php server list
const LANG_MAP: Record<string, { code: string; name: string }> = {
  hindi:     { code: 'hi', name: 'Hindi' },
  tamil:     { code: 'ta', name: 'Tamil' },
  telugu:    { code: 'te', name: 'Telugu' },
  malayalam: { code: 'ml', name: 'Malayalam' },
  bengali:   { code: 'bn', name: 'Bengali' },
  marathi:   { code: 'mr', name: 'Marathi' },
  kannada:   { code: 'kn', name: 'Kannada' },
  english:   { code: 'en', name: 'English' },
  japanese:  { code: 'ja', name: 'Japanese' },
};

function normalizeLang(raw: string): { code: string; name: string } {
  const key = raw.toLowerCase().trim();
  return LANG_MAP[key] ?? { code: 'und', name: raw };
}

export function decodePlayer1Payload(raw: string): string {
  const normalized = decodeURIComponent(raw)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

/**
 * Circuit breaker for the whole mirror set.
 *
 * watchanimeworld.one sits behind Cloudflare; when a non-browser client gets
 * challenge-blocked every attempt costs the full timeout with no chance of
 * success, which holds a slot in the runner's concurrency pool and delays the
 * other providers. The breaker stops the provider after repeated fully-dead
 * rounds and reopens on TTL expiry in case clearance returns.
 *
 * The threshold must exceed one round's probe count (slug probing legitimately
 * misses several paths before hitting the episode URL — series-path guesses
 * alone can miss twice). It was 2, which tripped mid-round and silently
 * blocked the real attempt; now it is 10, so only genuinely dead stretches
 * (Cloudflare-blocked rounds) open it.
 */
const BREAKER_TTL_MS = 5 * 60 * 1000;
const BREAKER_THRESHOLD = 10;
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

/** Cloudflare interstitials the fetcher can receive instead of real content. */
function isChallengePage(html: string): boolean {
  const t = html.toLowerCase();
  // Cloudflare also injects a harmless `challenge-platform` analytics script
  // into otherwise valid WordPress pages. Treat that marker as a challenge
  // only when the page has no player/content signal.
  const hasRealPageContent = /player1\.php|<iframe|<video|\.m3u8|\.mp4/i.test(html);
  return (
    t.includes('just a moment') ||
    t.includes('attention required') ||
    t.includes('cf-browser-verification') ||
    (t.includes('challenge-platform') && !hasRealPageContent) ||
    (t.includes('cloudflare') && t.includes('ray id'))
  );
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const html = await fetchTextWithBypass(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html', Referer: new URL(url).origin + '/' },
      timeoutMs: 7000,
    });
    if (!html || html.length <= 200 || isChallengePage(html)) return null;
    return html;
  } catch {
    return null;
  }
}

async function tryBases(path: string): Promise<{ html: string; base: string } | null> {
  if (Date.now() < breakerOpenUntil) return null;

  const results = await Promise.all(
    BASES.map(async (base) => {
      const html = await fetchHtml(`${base}${path}`);
      return html ? { html, base } : null;
    }),
  );
  const hit = results.find((r) => r !== null) ?? null;

  if (hit) {
    consecutiveFailures = 0;
  } else if (++consecutiveFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_TTL_MS;
    consecutiveFailures = 0;
  }
  return hit;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

async function findAnimeSlug(titles: string[]): Promise<{ slug: string; base: string } | null> {
  for (const query of buildSearchQueries(titles)) {
    const searchPaths = [
      `/?s=${encodeURIComponent(query)}`,
      `/search/${encodeURIComponent(query)}/`,
    ];

    for (const path of searchPaths) {
      const result = await tryBases(path);
      if (!result) continue;

      const $ = loadHtml(result.html);
      const hits: Array<{ slug: string; title: string; score: number }> = [];

      $.find('a[href]').each((_: number, el: any) => {
        const href: string = el.attr?.('href') ?? '';
        const m = href.match(/\/(?:anime|series|show)\/([^/?#]+)\/?$/) || href.match(/\/([^/?#]+)-\d+x\d+\/?$/);
        if (!m) return;
        const title: string = (el.attr?.('title') ?? el.text?.() ?? '').trim();
        if (!title) return;
        const slug = m[1]?.replace(/[-_]+$/, '');
        if (!slug || /^(home|search|anime|series)$/i.test(slug)) return;
        hits.push({ slug, title, score: scoreMatch(query, title) });
      });

      if (hits.length > 0) {
        hits.sort((a, b) => b.score - a.score);
        return { slug: hits[0].slug, base: result.base };
      }
    }
  }
  return null;
}

/**
 * Iframe hosts that are never a playable source.
 *
 * The `zephyr*` family is WAW's own wrapper: it does not play anything itself,
 * it re-frames whatever `player1.php` already gave us. Match the family rather
 * than one hostname so renames are already covered.
 */
const SKIP_IFRAME_HOSTS = /googletagmanager|recaptcha|doubleclick|histats|zephyr[a-z0-9-]*\./i;

/** True for an iframe src that is analytics, a captcha, or a known wrapper. */
function isSkippableIframe(src: string): boolean {
  if (!src) return true;
  if (SKIP_IFRAME_HOSTS.test(src)) return true;
  // about:blank / javascript: placeholders that some themes ship.
  return /^(?:about:|javascript:|data:)/i.test(src.trim());
}

function extractSources(html: string, pageUrl: string, base: string): SourceResult[] {
  const headers = { Referer: pageUrl, 'User-Agent': UA };
  const out: SourceResult[] = [];

  // WAW primary: base64-encoded player1.php server list (often on data-src, not src).
  const player1DataMatch = html.match(/player1\.php\?data=([^"'\s&]+)/i);
  const player1Match = player1DataMatch
    ? [null, null, player1DataMatch[1]] as unknown as RegExpMatchArray
    : html.match(/iframe[^>]+(?:src|data-src)=["']([^"']*\/api\/player1\.php\?data=([^"']+))["']/i);
  if (player1Match?.[2]) {
    try {
      const decoded = decodePlayer1Payload(player1Match[2]);
      const servers = JSON.parse(decoded) as Array<{ link?: string; url?: string; file?: string; language?: string; quality?: string }>;
      if (Array.isArray(servers)) {
        for (const server of servers) {
          const link = server.link ?? server.url ?? server.file ?? '';
          if (!link || !/^https?:\/\//.test(link)) continue;
          const lang = normalizeLang(server.language ?? 'Hindi');
          out.push({
            source: 'watchanimeworld',
            url: link,
            quality: normalizeQuality(server.quality ?? 'HD'),
            headers,
            subtitles: [],
            audioLanguage: lang.code,
            language: lang.name,
            sourceType: link.includes('.m3u8') ? 'hls' : detectSourceType(link),
          });
        }
        if (out.length > 0) return out;
      }
    } catch { /* fall through */ }
  }

  // Fallback: direct HLS/MP4 in page. WAW is a Hindi/Indian-dub catalogue, so
  // label the unlabelled fallbacks with its primary audio rather than leaving
  // them unset (which drops them from the language filter).
  const m3u8 = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
  if (m3u8) {
    out.push({ source: 'watchanimeworld', url: m3u8[1], quality: normalizeQuality('HD'), headers, subtitles: [], audioLanguage: 'hi', language: 'Hindi', sourceType: 'hls' });
    return out;
  }

  const mp4 = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) ?? html.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i);
  if (mp4) {
    out.push({ source: 'watchanimeworld', url: mp4[1], quality: normalizeQuality('HD'), headers, subtitles: [], audioLanguage: 'hi', language: 'Hindi', sourceType: 'mp4' });
    return out;
  }

  // iframes — skip analytics, captchas and the zephyr* wrapper.
  const $ = loadHtml(html);
  $.find('iframe[src], iframe[data-src]').each((_: number, el: any) => {
    const src: string = el.attr?.('src') ?? el.attr?.('data-src') ?? '';
    if (isSkippableIframe(src)) return;
    out.push({ source: 'watchanimeworld', url: src, quality: normalizeQuality(''), headers, subtitles: [], audioLanguage: 'hi', language: 'Hindi', sourceType: detectSourceType(src) });
  });

  return out;
}

const provider: StreamProvider = {
  name: 'watchanimeworld',
  sites: BASES,
  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const ep = opts.episode ?? 1;
      const titles = opts.titles;

      // Strategy 1: try the series page first, then the standard episode URL variants.
      for (const title of buildSearchQueries(titles)) {
        const slug = slugify(title);
        if (!slug) continue;

        const seriesPaths = [`/series/${slug}/`, `/anime/${slug}/`];
        for (const seriesPath of seriesPaths) {
          const result = await tryBases(seriesPath);
          if (result) {
            const sources = extractSources(result.html, `${result.base}${seriesPath}`, result.base);
            if (sources.length > 0) return sources;
          }
        }

        for (const season of [1, 2, 3]) {
          const epPaths = [
            `/episode/${slug}-${season}x${ep}/`,
            `/episode/${slug}-${ep}/`,
            `/episode/${slug}-ep-${ep}/`,
            `/episode/${slug}-${season}x${ep}/?ep=${ep}`,
          ];
          for (const epPath of epPaths) {
            const result = await tryBases(epPath);
            if (result) {
              const sources = extractSources(result.html, `${result.base}${epPath}`, result.base);
              if (sources.length > 0) return sources;
            }
          }
        }
      }

      // Strategy 2: Search → find slug → try the series and episode pages on the live host.
      const anime = await findAnimeSlug(titles);
      if (anime) {
        const seriesUrl = `/series/${anime.slug}/`;
        const seriesHtml = await fetchHtml(`${anime.base}${seriesUrl}`);
        if (seriesHtml) {
          const sources = extractSources(seriesHtml, `${anime.base}${seriesUrl}`, anime.base);
          if (sources.length > 0) return sources;
        }

        for (const season of [1, 2, 3]) {
          const epPaths = [
            `/episode/${anime.slug}-${season}x${ep}/`,
            `/episode/${anime.slug}-${ep}/`,
            `/episode/${anime.slug}-ep-${ep}/`,
          ];
          for (const epPath of epPaths) {
            const html = await fetchHtml(`${anime.base}${epPath}`);
            if (html) {
              const sources = extractSources(html, `${anime.base}${epPath}`, anime.base);
              if (sources.length > 0) return sources;
            }
          }
        }
      }

      return [];
    } catch { return []; }
  },
};

export default provider;
