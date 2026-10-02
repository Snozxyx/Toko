/**
 * turkanime — Turkish-subtitled anime (https://turkanime.co, mirror .live).
 *
 * PHP site. Flow confirmed from `MALSync/MALSync` (src/pages/TurkAnime) and
 * `KebabLord/turkanime-indirici`:
 *
 *   POST /arama            form `arama={query}`         → anime slug + name
 *   GET  /anime/{slug}     page                         → animeId (twitter image)
 *   GET  /ajax/bolumler&animeId={id}  (literal `&`)     → episode video slugs
 *   GET  /video/{videoSlug}                             → fansub player buttons
 *   GET  /ajax/videosec&b={b64}&v=...                   → one player's embed
 *
 * All /ajax/* routes require `X-Requested-With: XMLHttpRequest`, and the site
 * sits behind Cloudflare with Firefox-TLS gating, so every request goes through
 * `fetchTextWithBypass`.
 *
 * TOKEN RISK (confirmed, and the hard limit of this provider): a videosec
 * response is EITHER a plain `<iframe src="…">` OR an encrypted
 * `/embed/#/url/{cipher}?status`. That cipher is CryptoJS AES-CBC (salted key)
 * and must be decrypted — some players (Alucard/Amaterasu/Bankai/HDVID) then
 * need a further unmask step. That key material is not available here, so this
 * provider extracts ONLY the plain-iframe players and skips every encrypted
 * one. On titles where all fansubs use the encrypted player, it returns [].
 *
 * best-effort: unverified — the end-to-end flow could not be exercised live
 * (authoring IP is bot-blocked; turkanime hung the socket on clean-IP probes).
 */

import { normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { SourceOptions, SourceResult, StreamProvider } from '../../types/index.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const BASES = ['https://www.turkanime.co', 'https://turkanime.co', 'https://www.turkanime.live'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

function ajaxHeaders(base: string, referer?: string): Record<string, string> {
  return {
    'User-Agent': UA,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: '*/*',
    Referer: referer || `${base}/`,
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** POST /arama → best-matching anime slug for the requested titles. */
async function searchSlug(base: string, titles: string[], timeoutMs: number): Promise<string | null> {
  for (const query of buildSearchQueries(titles).slice(0, 3)) {
    const html = await fetchTextWithBypass(`${base}/arama`, {
      method: 'POST',
      body: `arama=${encodeURIComponent(query)}`,
      headers: {
        ...ajaxHeaders(base, `${base}/`),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      timeoutMs,
    });
    if (!html) continue;

    // Primary: anchor list `/anime/{slug}" ... title="{Name} izle"`.
    const hits: Array<{ slug: string; title: string }> = [];
    for (const m of html.matchAll(/\/anime\/([^"'>]+)["'][^>]*?title=["']([^"]+?)\s*izle/gi)) {
      hits.push({ slug: m[1], title: m[2] });
    }
    if (hits.length) {
      hits.sort((a, b) => scoreMatch(query, b.title) - scoreMatch(query, a.title));
      return hits[0].slug;
    }

    // Fallback: a single exact hit redirects via `window.location = "anime/{slug}"`.
    const redirect = html.match(/window\.location\s*=\s*["']anime\/([^"']+)["']/i);
    if (redirect) return redirect[1];
  }
  return null;
}

/** GET /anime/{slug} → the numeric animeId used by the /ajax endpoints. */
async function fetchAnimeId(base: string, slug: string, timeoutMs: number): Promise<string | null> {
  const html = await fetchTextWithBypass(`${base}/anime/${slug}`, {
    headers: ajaxHeaders(base, `${base}/`),
    timeoutMs,
  });
  if (!html) return null;
  const m = html.match(/twitter.image["']?\s*content=["'].*?serilerb\/(\d+)\.jpg/i);
  return m ? m[1] : null;
}

/** GET /ajax/bolumler&animeId={id} → the video slug for the requested episode. */
async function fetchEpisodeSlug(
  base: string,
  animeId: string,
  episode: number,
  timeoutMs: number,
): Promise<string | null> {
  const html = await fetchTextWithBypass(`${base}/ajax/bolumler&animeId=${animeId}`, {
    headers: ajaxHeaders(base, `${base}/anime/`),
    timeoutMs,
  });
  if (!html) return null;

  const entries: Array<{ slug: string; num: number }> = [];
  for (const m of html.matchAll(/\/video\/([^"'?\\]+)[^>]*?title=\\?["']([^"'\\]+)/gi)) {
    const slug = m[1];
    // Episode number comes from the slug tail (`…-24-bolum`) or the title.
    const numMatch = slug.match(/-(\d+)-bolum/i) || m[2].match(/(\d+)\s*\.?\s*B[oö]l[uü]m/i);
    entries.push({ slug, num: numMatch ? Number(numMatch[1]) : NaN });
  }
  if (entries.length === 0) return null;

  const exact = entries.find((e) => e.num === episode);
  if (exact) return exact.slug;
  // No clean number match: index into the list (it is ordered ep 1..N).
  return entries[episode - 1]?.slug ?? entries[0].slug;
}

interface PlayerButton {
  vpath: string;
  player: string;
}

/** GET /video/{slug} → the videosec AJAX paths, one per fansub player. */
async function fetchPlayers(base: string, videoSlug: string, timeoutMs: number): Promise<PlayerButton[]> {
  const html = await fetchTextWithBypass(`${base}/video/${videoSlug}`, {
    headers: ajaxHeaders(base, `${base}/`),
    timeoutMs,
  });
  if (!html) return [];

  const players: PlayerButton[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/(ajax\/videosec&b=[A-Za-z0-9]+&v=[^'"]*?)['"][\s\S]*?<\/span>\s?([^<]*?)<\/button/gi)) {
    const vpath = m[1];
    if (seen.has(vpath)) continue;
    seen.add(vpath);
    players.push({ vpath, player: m[2].trim() || 'player' });
  }
  return players;
}

/** Slugify a fansub player label for a stable `source` id. */
function playerSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'player';
}

/**
 * Resolve one videosec path to a plain-iframe embed URL, or null when the
 * player hands back the encrypted `/embed/#/url/{cipher}` form this provider
 * cannot decrypt (see the TOKEN RISK note at the top of the file).
 */
async function resolvePlayer(base: string, vpath: string, timeoutMs: number): Promise<string | null> {
  const html = await fetchTextWithBypass(`${base}/${vpath}`, {
    headers: ajaxHeaders(base, `${base}/`),
    timeoutMs,
  });
  if (!html) return null;

  const iframe = html.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (!iframe) return null;

  let src = iframe[1].replace(/&amp;/g, '&').trim();
  if (src.startsWith('//')) src = `https:${src}`;
  else if (src.startsWith('/')) src = `${base}${src}`;

  // Encrypted token form — decryption is not ported, so skip it.
  if (/\/embed\/#\/url\//i.test(src) || !/^https?:\/\//i.test(src)) return null;
  return src;
}

const provider: StreamProvider = {
  name: 'turkanime',
  sites: BASES,

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const episode = opts.episode ?? 1;
      const timeoutMs = Math.max(5000, Math.min(15000, opts.providerOptions?.timeoutMs ?? 12000));

      for (const base of BASES) {
        const slug = await searchSlug(base, opts.titles, timeoutMs);
        if (!slug) continue;

        const animeId = await fetchAnimeId(base, slug, timeoutMs);
        if (!animeId) continue;

        const videoSlug = await fetchEpisodeSlug(base, animeId, episode, timeoutMs);
        if (!videoSlug) continue;

        const players = await fetchPlayers(base, videoSlug, timeoutMs);
        if (players.length === 0) continue;

        const resolved = await Promise.allSettled(
          players.map(async (p) => ({ player: p.player, url: await resolvePlayer(base, p.vpath, timeoutMs) })),
        );

        const out: SourceResult[] = [];
        const seen = new Set<string>();
        for (const r of resolved) {
          if (r.status !== 'fulfilled' || !r.value.url || seen.has(r.value.url)) continue;
          seen.add(r.value.url);
          const embedUrl = r.value.url;
          const embedOrigin = originOf(embedUrl);
          const embedReferer = embedOrigin ? `${embedOrigin}/` : `${base}/`;
          // Pull a direct m3u8/mp4 out of the player iframe when possible; keep
          // the embed as a fallback the app's webview resolver can still play.
          const res = await resolveToDirectOrEmbed(embedUrl, embedReferer);
          if (!res) continue;
          const headers: Record<string, string> =
            res.url !== embedUrl && res.headers
              ? { 'User-Agent': UA, ...res.headers }
              : { Referer: embedReferer, 'User-Agent': UA };
          const sslug = playerSlug(r.value.player);
          out.push({
            source: `turkanime-${sslug}`,
            url: res.url,
            quality: normalizeQuality(res.quality ?? ''),
            headers,
            subtitles: [],
            // Turkish-subtitled Japanese audio.
            audioLanguage: 'ja',
            language: 'Turkish Sub',
            sourceType: res.sourceType,
            providerName: 'TurkAnime',
            providerKey: 'turkanime',
            server: `turkanime-${sslug}`,
          });
        }
        if (out.length) return out;
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
