/**
 * senshi — https://senshi.to
 *
 * best-effort: site is a placeholder as of authoring; scaffold for when it
 * launches. As of 2026-10-01 the page serves only "Senshi Project - New
 * Website." — there is no catalogue, search endpoint, or player to scrape, so
 * `single()` returns [] today without making a wasted round trip count against
 * the provider budget.
 *
 * The structure below mirrors the other stream providers (search → episode →
 * extract) so that wiring up the real endpoints — once the site ships them — is
 * a matter of filling in `searchSlug`, `findEpisodeUrl`, and `extractStreams`
 * rather than rebuilding the adapter. Each is marked `// best-effort:
 * unverified` because none could be confirmed against a live catalogue.
 */

import { normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries } from '../../utils/scraping/title-normalizer.js';
import type { SourceOptions, SourceResult, StreamProvider } from '../../types/index.js';
import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const BASE = 'https://senshi.to';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

/** Heuristic: is this HTML the launched site, or still the placeholder page? */
function looksLikePlaceholder(html: string): boolean {
  return /new\s+website|coming\s+soon|senshi\s+project/i.test(html) && !/<iframe|\.m3u8/i.test(html);
}

/**
 * Pull any direct/iframe stream URL out of a watch page.
 * best-effort: unverified — selectors are generic until the real markup exists.
 */
async function extractStreams(html: string, pageUrl: string): Promise<SourceResult[]> {
  const headers = { Referer: pageUrl, 'User-Agent': UA };
  const out: SourceResult[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({
      source: 'senshi',
      url: m[1],
      quality: normalizeQuality(''),
      headers,
      subtitles: [],
      audioLanguage: 'ja',
      sourceType: 'hls',
    });
  }

  if (out.length === 0) {
    const $ = loadHtml(html);
    const iframes: string[] = [];
    $.find('iframe[src], iframe[data-src]').each((_: number, el: any) => {
      const src: string = el.attr?.('src') ?? el.attr?.('data-src') ?? '';
      if (!src || /recaptcha|doubleclick|googletagmanager/i.test(src) || seen.has(src)) return;
      seen.add(src);
      iframes.push(src.startsWith('http') ? src : new URL(src, pageUrl).toString());
    });
    // Resolve each iframe embed to a direct m3u8/mp4 when possible, else keep
    // the embed as a fallback the app's webview resolver can play.
    for (const embedUrl of iframes) {
      const res = await resolveToDirectOrEmbed(embedUrl, pageUrl);
      if (!res) continue;
      const h = res.url !== embedUrl && res.headers ? { 'User-Agent': UA, ...res.headers } : headers;
      out.push({
        source: 'senshi',
        url: res.url,
        quality: normalizeQuality(res.quality ?? ''),
        headers: h,
        subtitles: [],
        audioLanguage: 'ja',
        sourceType: res.sourceType,
      });
    }
  }
  return out;
}

const provider: StreamProvider = {
  name: 'senshi',
  sites: [BASE],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const timeoutMs = Math.max(4000, Math.min(10000, opts.providerOptions?.timeoutMs ?? 8000));

      // One cheap probe: if the homepage is still the placeholder, stop here.
      const home = await fetchText(`${BASE}/`, {
        headers: { 'User-Agent': UA, Referer: `${BASE}/` },
        timeoutMs,
      });
      if (!home || looksLikePlaceholder(home)) return [];

      // Site has launched — attempt a generic search → watch-page scrape.
      // best-effort: unverified — the search route and watch-URL shape are
      // guesses that must be confirmed against the live site.
      const episode = opts.episode ?? 1;
      for (const query of buildSearchQueries(opts.titles).slice(0, 2)) {
        const searchHtml = await fetchText(
          `${BASE}/search?keyword=${encodeURIComponent(query)}`,
          { headers: { 'User-Agent': UA, Referer: `${BASE}/` }, timeoutMs },
        );
        if (!searchHtml) continue;

        const $ = loadHtml(searchHtml);
        let watchUrl = '';
        $.find('a[href*="/watch/"], a[href*="/anime/"]').each((_: number, el: any) => {
          if (watchUrl) return;
          const href: string = el.attr?.('href') ?? '';
          if (href) watchUrl = href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
        });
        if (!watchUrl) continue;

        // Naive episode-URL derivation; real pattern TBD.
        const epUrl = /\/watch\//.test(watchUrl) ? watchUrl : `${watchUrl.replace(/\/$/, '')}/episode-${episode}`;
        const watchHtml = await fetchText(epUrl, {
          headers: { 'User-Agent': UA, Referer: `${BASE}/` },
          timeoutMs,
        });
        if (!watchHtml) continue;

        const sources = await extractStreams(watchHtml, epUrl);
        if (sources.length) return sources;
      }
      return [];
    } catch {
      return [];
    }
  },

  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    return provider.single({ ...opts, episode: opts.episode ?? 1 });
  },
};

export default provider;
