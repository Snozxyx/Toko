/**
 * Shahiid Anime (Arabic) — https://shahiid-anime.net
 *
 * WordPress site on a custom theme ("shahiidanime-220px-v8.4"). It offers both
 * Arabic SUBBED (Japanese audio + Arabic subtitles) and Arabic DUBBED tracks,
 * kept in separate URL trees:
 *   Subbed:  /series/{slug}/ , /seasons/{slug}/ , /episodes/{slug}-ep-{N}/
 *   Dubbed:  /seriesDubbed/{slug}/ , /seasonsDubbed/{slug}/ , /episodesDubbed/…
 *   Search:  WordPress /?s={q}  AND a live-search AJAX (action=data_fetch).
 *
 * CONFIRMED (fingerprinted 2026-10 over a clean IP):
 *   - /series/{slug}/ 302-redirects to a per-series season listing
 *     (/seasons/?serie={id}); the /seasons/{slug}/ pages list the episode links.
 *   - Episode slugs are NOT a clean "{romaji}-ep-{N}" (that only happens for a
 *     few long-runners like One Piece); most are percent-encoded Arabic, e.g.
 *     /episodes/one-piece-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-01-…/, so we must
 *     navigate search -> season -> episode link rather than guess the URL.
 *   - The watch page renders server tabs:
 *       <div class="movies-servers"><ul class="tabs-ul"><li>
 *         <a class="buttosn" data-post="{id}" data-serv="{serv}"
 *            data-frameserver="{code}"> … </a>
 *     The active tab's <iframe> is pre-rendered; the rest resolve via
 *       POST /wp-admin/admin-ajax.php
 *       action=codecanal_ajax_request&post={post}&frameserver={code}&serv={serv}&is_film=
 *     which returns `<iframe src="…embed…">` (share4max.com, turbovidhls.com,
 *     ok.ru, videa, …). Verified: Turboviplay->turbovidhls.com/t/{code},
 *     Okru->ok.ru/videoembed/{code}, Megamax->share4max.com/iframe/{code}.
 *
 * Audio: a subbed episode URL => Japanese audio (audioLanguage 'ja'); a dubbed
 * URL => Arabic dub (audioLanguage 'ar'). A given watch page is one track.
 *
 * Transport: plain fetch worked from a clean IP (no Cloudflare challenge).
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { StreamProvider, SourceOptions, SourceResult } from '../../types/index.js';
import { fetchResponse, loadHtml } from '../../utils/http/fetch.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const BASE = 'https://shahiid-anime.net';
const AJAX = `${BASE}/wp-admin/admin-ajax.php`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function headersFor(referer = `${BASE}/`): Record<string, string> {
  return { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ar,en;q=0.7', Referer: referer };
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

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Episode number from an episode slug/URL (handles ep-N, Arabic الحلقة N, bare N). */
function episodeNumOf(url: string): number | null {
  const dec = safeDecode(url);
  const m = dec.match(/(?:ep[-_\s]?|episode[-_\s]?|الحلقة[-_\s]?)0*(\d{1,4})/i);
  if (m) return parseInt(m[1], 10);
  const nums = dec.match(/\d{1,4}/g);
  return nums && nums.length ? parseInt(nums[nums.length - 1], 10) : null;
}

function isDubUrl(url: string): boolean {
  return /Dubbed/i.test(url) || /مدبلج/.test(safeDecode(url));
}

/** Latin tokens pulled out of a (decoded) URL — used to score Arabic-titled hits. */
function latinOf(url: string): string {
  return safeDecode(url)
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
}

interface Candidate {
  url: string;
  score: number;
}
function collectCandidates(html: string, q: string, out: Candidate[], seen: Set<string>): void {
  const $ = loadHtml(html);
  $.find('a[href]').each((_: number, el: any) => {
    let href: string = el.attr?.('href') ?? '';
    if (!href) return;
    if (href.startsWith('/')) href = `${BASE}${href}`;
    if (!/\/(series|seriesDubbed|seasons|seasonsDubbed|anime)\//.test(href)) return;
    if (/\/(page|feed|tag|category|genre)\//.test(href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    const title: string = (el.attr?.('title') ?? el.text?.() ?? '').replace(/\s+/g, ' ').trim();
    const score = Math.max(scoreMatch(q, title), scoreMatch(q, latinOf(href)));
    out.push({ url: href, score });
  });
}

async function searchCandidates(titles: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const q of buildSearchQueries(titles).slice(0, 2)) {
    // 1) live-search AJAX (compact result list).
    try {
      const res = await fetchResponse(AJAX, {
        method: 'POST',
        headers: {
          ...headersFor(`${BASE}/`),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE,
        },
        body: `action=data_fetch&keyword=${encodeURIComponent(q)}`,
        timeoutMs: 10000,
      });
      if (res.ok) collectCandidates(await res.text(), q, out, seen);
    } catch {
      /* ignore and try classic search */
    }
    // 2) classic WordPress search fallback.
    if (out.length === 0) {
      const html = await fetchHtml(`${BASE}/?s=${encodeURIComponent(q)}`);
      if (html) collectCandidates(html, q, out, seen);
    }
    if (out.length) break;
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
function linksMatching(html: string, re: RegExp): string[] {
  const $ = loadHtml(html);
  const links: string[] = [];
  $.find('a[href]').each((_: number, el: any) => {
    let href: string = el.attr?.('href') ?? '';
    if (!href) return;
    if (href.startsWith('/')) href = `${BASE}${href}`;
    if (re.test(href) && !/\/(page|feed)\//.test(href)) links.push(href);
  });
  return [...new Set(links)];
}

const EP_RE = /\/(episodes|episodesDubbed)\//;
const SEASON_RE = /\/(seasons|seasonsDubbed)\/[^/?#]+\/?($|[?#])/;

/** search hit (series/seasons page) -> the episode watch URL for `ep`. */
async function findEpisodeUrl(candidateUrl: string, ep: number): Promise<string | null> {
  const html = await fetchHtml(candidateUrl);
  if (!html) return null;
  let eps = linksMatching(html, EP_RE);
  let match = eps.find((u) => episodeNumOf(u) === ep);
  if (match) return match;
  // Not an episode listing — likely a per-series season index; descend.
  for (const season of linksMatching(html, SEASON_RE).slice(0, 4)) {
    const sh = await fetchHtml(season, candidateUrl);
    if (!sh) continue;
    eps = linksMatching(sh, EP_RE);
    match = eps.find((u) => episodeNumOf(u) === ep);
    if (match) return match;
  }
  return null;
}

interface Tab {
  post: string;
  serv: string;
  frameserver: string;
  label: string;
}

function parseServerTabs(html: string): Tab[] {
  const $ = loadHtml(html);
  const tabs: Tab[] = [];
  $.find('.movies-servers a.buttosn, .tabs-ul a.buttosn, a.buttosn').each((_: number, el: any) => {
    const post: string = el.attr?.('data-post') ?? '';
    const serv: string = el.attr?.('data-serv') ?? '';
    const frameserver: string = el.attr?.('data-frameserver') ?? '';
    const label: string = (el.text?.() ?? '').replace(/\s+/g, ' ').trim();
    if (post && (frameserver || serv)) tabs.push({ post, serv, frameserver, label });
  });
  return tabs;
}
function iframeSrcFrom(html: string): string | null {
  const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!m) return null;
  let src = m[1].replace(/&#0?38;|&amp;/g, '&').trim();
  if (src.startsWith('//')) src = 'https:' + src;
  return /^https?:\/\//.test(src) ? src : null;
}

const JUNK_HOST = /googletagmanager|recaptcha|disqus|facebook|platform\.twitter|about:blank/i;

async function resolveTab(tab: Tab, pageUrl: string): Promise<string | null> {
  try {
    const res = await fetchResponse(AJAX, {
      method: 'POST',
      headers: {
        ...headersFor(pageUrl),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: BASE,
      },
      body: `action=codecanal_ajax_request&post=${encodeURIComponent(tab.post)}&frameserver=${encodeURIComponent(tab.frameserver)}&serv=${encodeURIComponent(tab.serv)}&is_film=`,
      timeoutMs: 10000,
    });
    if (!res.ok) return null;
    return iframeSrcFrom(await res.text());
  } catch {
    return null;
  }
}

/** Clean ASCII server token from a (possibly Arabic) tab label. */
function serverName(label: string, fallbackUrl?: string): string {
  const ascii = label
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (ascii) return ascii;
  if (fallbackUrl) {
    try {
      return new URL(fallbackUrl).hostname.replace(/^www\./, '').split('.').slice(-2, -1)[0] || 'server';
    } catch {
      /* ignore */
    }
  }
  return 'server';
}
async function extractServers(html: string, pageUrl: string): Promise<SourceResult[]> {
  const dub = isDubUrl(pageUrl);
  const audioLanguage = dub ? 'ar' : 'ja';
  const language = dub ? 'Arabic' : 'Japanese';
  const tabs = parseServerTabs(html);
  const out: SourceResult[] = [];
  const seen = new Set<string>();

  // Resolve each server's embed to a direct m3u8/mp4 when possible; otherwise
  // keep the embed URL as a fallback the app's webview resolver can play.
  const emit = async (embedUrl: string, server: string): Promise<void> => {
    const r = await resolveToDirectOrEmbed(embedUrl, pageUrl);
    if (!r) return;
    // When the resolver produced a NEW CDN url, use its headers; a passthrough or
    // embed fallback keeps the site's own Referer.
    const headers: Record<string, string> =
      r.url !== embedUrl && r.headers ? { 'User-Agent': UA, ...r.headers } : { Referer: pageUrl, 'User-Agent': UA };
    out.push({
      source: `shahiid-${server}-${audioLanguage}`,
      url: r.url,
      quality: normalizeQuality(r.quality ?? ''),
      headers,
      subtitles: [],
      audioLanguage,
      language,
      server,
      sourceType: r.sourceType,
    });
  };

  // The active tab's iframe is pre-rendered — grab it without an AJAX round-trip.
  const active = iframeSrcFrom(html);
  if (active && !JUNK_HOST.test(active)) {
    seen.add(active);
    await emit(active, serverName(tabs[0]?.label ?? '', active));
  }

  // Remaining servers resolve through admin-ajax (codecanal_ajax_request).
  const resolved = await Promise.all(tabs.map((t) => resolveTab(t, pageUrl).then((src) => ({ t, src }))));
  for (const { t, src } of resolved) {
    if (!src || seen.has(src) || JUNK_HOST.test(src)) continue;
    seen.add(src);
    await emit(src, serverName(t.label, src));
  }
  return out;
}

const provider: StreamProvider = {
  name: 'shahiid',
  sites: [BASE],
  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const ep = opts.episode ?? 1;
      for (const c of await searchCandidates(opts.titles)) {
        // Movies/OVAs live under /anime/{slug}/ and ARE the watch page.
        if (/\/anime\//.test(c.url)) {
          const html = await fetchHtml(c.url);
          if (html) {
            const s = await extractServers(html, c.url);
            if (s.length) return s;
          }
          continue;
        }
        const epUrl = await findEpisodeUrl(c.url, ep);
        if (!epUrl) continue;
        const html = await fetchHtml(epUrl, c.url);
        if (!html) continue;
        const s = await extractServers(html, epUrl);
        if (s.length) return s;
      }
      return [];
    } catch {
      return [];
    }
  },
};

export default provider;
