/**
 * AnimeXin — https://animexin.dev  (WordPress "AnimeStream" theme, donghua)
 *
 * Same theme family as 4anime, so the shape mirrors fouranime.ts:
 *   Search:  /?s={query}                 → .listupd .bsx a  → /anime/{slug}/
 *   Anime:   /anime/{slug}/              → .eplister a      → episode links
 *   Episode: /{slug}-episode-{N}-indonesia-english-sub/
 *
 * CONFIRMED (clean-IP fingerprint 2026-10): the watch page carries every mirror
 * inline as base64 inside
 *   <select class="mirror"><option value="{base64}">{label}</option> …
 * where each decoded value is an `<iframe … src="…">` embed (dailymotion,
 * odysee, ok.ru, d.tube, mega.nz, rumble, dood/playmogo, …). No admin-ajax
 * round-trip is needed — the options are present in the initial HTML.
 *
 * HARDSUB: subs are burned-in ("Multi Sub" / "English|Indonesia"), so we keep
 * the ORIGINAL audio code and flag the burned-in track ONLY in the language
 * label. Donghua default to 'zh'.
 * best-effort: unverified — a handful of AnimeXin titles are Japanese-audio, but
 *   the page markup does not distinguish them, so audioLanguage is assumed 'zh'.
 *
 * Transport: plain fetch (no Cloudflare challenge on a clean IP).
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch, slugifyTitle } from '../../utils/scraping/title-normalizer.js';
import type { StreamProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse, loadHtml } from '../../utils/http/fetch.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const BASE = 'https://animexin.dev';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function headersFor(referer = `${BASE}/`): Record<string, string> {
  return { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en;q=0.9', Referer: referer };
}

async function fetchHtml(url: string, referer = `${BASE}/`): Promise<string | null> {
  try {
    const res = await fetchResponse(url, { headers: headersFor(referer), timeoutMs: 12000 });
    if (!res.ok) return null;
    const html = await res.text();
    return html && html.length > 200 ? html : null;
  } catch {
    return null;
  }
}
function b64decode(s: string): string {
  try {
    if (typeof atob === 'function') return atob(s);
    return Buffer.from(s, 'base64').toString('binary');
  } catch {
    return '';
  }
}

/** Short server token from an embed host. */
function serverFromUrl(url: string): string {
  try {
    const host = new URL(url.startsWith('//') ? 'https:' + url : url).hostname.replace(/^www\./, '');
    const map: Record<string, string> = {
      'dailymotion.com': 'dailymotion',
      'geo.dailymotion.com': 'dailymotion',
      'odysee.com': 'odysee',
      'ok.ru': 'okru',
      'd.tube': 'dtube',
      'emb.d.tube': 'dtube',
      'mega.nz': 'mega',
      'rumble.com': 'rumble',
      'playmogo.com': 'dood',
    };
    if (map[host]) return map[host];
    return host.split('.').slice(-2, -1)[0] || host.replace(/[^a-z0-9]+/gi, '') || 'server';
  } catch {
    return 'server';
  }
}

/** Burned-in sub language -> human label (audio stays original). */
function labelFor(optLabel: string): string {
  const t = optLabel.toLowerCase();
  if (t.includes('english') && t.includes('indonesia')) return 'Multi Sub';
  if (t.includes('english')) return 'English (Hardsub)';
  if (t.includes('indonesia')) return 'Indonesian (Hardsub)';
  return 'Multi Sub';
}

const JUNK_HOST = /googletagmanager|recaptcha|disqus|facebook|platform\.twitter|about:blank/i;
async function extractServers(html: string, pageUrl: string): Promise<SourceResult[]> {
  const $ = loadHtml(html);
  const seen = new Set<string>();
  const candidates: Array<{ src: string; language: string; server: string }> = [];

  const add = (src: string, language: string, server: string) => {
    if (!/^https?:\/\//.test(src) || seen.has(src) || JUNK_HOST.test(src)) return;
    seen.add(src);
    candidates.push({ src, language, server });
  };

  // Primary: base64 <option> mirrors.
  $.find('select.mirror option, .mirror option, option[value]').each((_: number, el: any) => {
    const value: string = el.attr?.('value') ?? '';
    if (!value || value.length < 16) return;
    const decoded = b64decode(value.trim());
    if (!/iframe|src=/i.test(decoded)) return;
    let src = decoded.match(/src=["']([^"']+)["']/i)?.[1] ?? '';
    if (!src) return;
    src = src.replace(/&amp;/g, '&').trim();
    if (src.startsWith('//')) src = 'https:' + src;
    const label: string = (el.text?.() ?? '').replace(/\s+/g, ' ').trim();
    add(src, labelFor(label), serverFromUrl(src));
  });

  // Fallback: a single pre-rendered iframe (older/edge pages).
  if (candidates.length === 0) {
    $.find('#pembed iframe[src], .player-embed iframe[src], iframe[src]').each((_: number, el: any) => {
      let src: string = el.attr?.('src') ?? '';
      if (!src) return;
      src = src.replace(/&amp;/g, '&').trim();
      if (src.startsWith('//')) src = 'https:' + src;
      add(src, 'Multi Sub', serverFromUrl(src));
    });
  }

  // Resolve each mirror to a direct m3u8/mp4 when possible, else keep the embed.
  const out: SourceResult[] = [];
  let n = 0;
  for (const c of candidates) {
    const r = await resolveToDirectOrEmbed(c.src, pageUrl);
    if (!r) continue;
    const headers: Record<string, string> =
      r.url !== c.src && r.headers ? { 'User-Agent': UA, ...r.headers } : { Referer: pageUrl, 'User-Agent': UA };
    out.push({
      source: `animexin-${c.server}-${++n}`,
      url: r.url,
      quality: normalizeQuality(r.quality ?? ''),
      headers,
      subtitles: [],
      audioLanguage: 'zh', // best-effort: donghua original audio (a few titles are 'ja')
      language: c.language, // burned-in subs flagged here only
      server: c.server,
      sourceType: r.sourceType,
    });
  }
  return out;
}
async function findEpisodeViaSearch(titles: string[], ep: number): Promise<string | null> {
  const re = new RegExp(`-episode-${ep}(?:[^0-9]|$)`, 'i');
  for (const q of buildSearchQueries(titles).slice(0, 2)) {
    const html = await fetchHtml(`${BASE}/?s=${encodeURIComponent(q)}`);
    if (!html) continue;
    const $ = loadHtml(html);
    const hits: Array<{ url: string; score: number }> = [];
    $.find('.listupd .bsx a[href], a[href*="/anime/"]').each((_: number, el: any) => {
      let href: string = el.attr?.('href') ?? '';
      if (!href || !/\/anime\//.test(href)) return;
      if (href.startsWith('/')) href = `${BASE}${href}`;
      const title: string = (el.attr?.('title') ?? el.text?.() ?? '').replace(/\s+/g, ' ').trim();
      hits.push({ url: href, score: scoreMatch(q, title) });
    });
    if (!hits.length) continue;
    hits.sort((a, b) => b.score - a.score);

    const animeHtml = await fetchHtml(hits[0].url);
    if (!animeHtml) continue;
    const $$ = loadHtml(animeHtml);
    let match: string | null = null;
    $$.find('.eplister a[href], a[href*="-episode-"]').each((_: number, el: any) => {
      if (match) return;
      let href: string = el.attr?.('href') ?? '';
      if (!href) return;
      if (href.startsWith('/')) href = `${BASE}${href}`;
      if (re.test(href)) match = href;
    });
    if (match) return match;
  }
  return null;
}

const provider: StreamProvider = {
  name: 'animexin',
  sites: [BASE],
  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const ep = opts.episode ?? 1;

      // Strategy 1: direct episode-URL probe from the slugified title.
      for (const q of buildSearchQueries(opts.titles).slice(0, 3)) {
        const slug = slugifyTitle(q);
        if (!slug) continue;
        const candidates = [
          `${BASE}/${slug}-episode-${ep}-indonesia-english-sub/`,
          `${BASE}/${slug}-episode-${ep}-indonesian-english-sub/`,
          `${BASE}/${slug}-episode-${ep}-english-sub/`,
          `${BASE}/${slug}-episode-${ep}-sub-indo/`,
        ];
        for (const url of candidates) {
          const html = await fetchHtml(url);
          if (!html) continue;
          const s = await extractServers(html, url);
          if (s.length) return s;
        }
      }

      // Strategy 2: search -> anime page -> episode link.
      const epUrl = await findEpisodeViaSearch(opts.titles, ep);
      if (epUrl) {
        const html = await fetchHtml(epUrl, `${BASE}/`);
        if (html) {
          const s = await extractServers(html, epUrl);
          if (s.length) return s;
        }
      }
      return [];
    } catch {
      return [];
    }
  },
};

export default provider;
