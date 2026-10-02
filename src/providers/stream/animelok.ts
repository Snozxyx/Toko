/**
 * Animelok — direct-stream adapter for animelok.cc.
 *
 * Animelok has rebranded repeatedly (animelok.xyz → .live → .cc). The old
 * `.live` host is now NXDOMAIN and its `/api/anime/{slug}/episodes/{n}` JSON
 * route 404s. The live site (`animelok.cc`) is a Next.js app that keys every
 * title on its AniList id — `/anime/{anilistId}` → `/watch/{anilistId}` — and
 * the watch page loads servers from a single JSON endpoint (reverse-engineered
 * from the client bundle, verified live):
 *
 *   GET /api/anilist/{anilistId}/{episode}
 *     → { success, servers: [{ id, source, server, type, language, url, softsub }] }
 *
 * `url` is an embed, not a direct stream:
 *   - flixcloud.cc/e/{id}?v=N   → decrypted via resolveFlixCloud (same upstream
 *                                 as the `reanime` provider), yields HLS + subs;
 *   - animesalt player.php?data=<base64>  → decodes to a [{language,link}] list
 *                                 (one abyssplayer embed per dub language);
 *   - abyssplayer / vexal / misc → resolved to a direct m3u8/mp4 when possible,
 *                                 else emitted as a `custom` embed fallback.
 *
 * No title search is needed: the AniList id is the primary key, so this is both
 * fast and reliable. Every server is emitted as its own source (all mirrors,
 * both sub/dub tracks) with per-source language labels.
 */
import { normalizeQuality, detectSourceType } from '../../utils/scraping/quality.js';
import { normalizeLangCode } from '../../utils/scraping/language.js';
import { resolveFlixCloud } from '../../utils/common/flixcloud.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';
import type { StreamProvider, SourceOptions, SourceResult, SubtitleTrack } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';

const BASE = 'https://animelok.cc';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

interface RawServer {
  id?: string;
  source?: string;
  server?: string;
  type?: string; // 'sub' | 'dub' | 'raw'
  language?: string | null;
  url?: string;
  softsub?: boolean;
}

interface ServersResponse {
  success?: boolean;
  servers?: RawServer[];
}

/** A single playable candidate after animesalt-bundle expansion. */
interface Candidate {
  url: string;
  source: string;
  server: string;
  type: string;
  language: string | null;
}

// ── Language mapping ──────────────────────────────────────────────────────────

interface LangLabel { code: string; name: string }

/**
 * Resolve an audio-language label. An explicit language (from the API field or a
 * decoded animesalt bundle) always wins. Otherwise fall back to the sub/dub
 * convention these hianime-style upstreams use: `sub` = original Japanese audio
 * with soft subs, `dub` = English dub (HD-1/HD-2 = megacloud English dub).
 */
function langFor(explicit: string | null | undefined, type: string): LangLabel {
  if (explicit) {
    const l = normalizeLangCode(explicit);
    if (l.code !== 'und') return l;
  }
  const t = String(type || '').toLowerCase();
  if (t === 'dub') return { code: 'en', name: 'English Dub' };
  if (t === 'sub') return { code: 'ja', name: 'Japanese (Sub)' };
  return { code: 'und', name: 'Multi' };
}

// ── animesalt player.php?data=<base64> → [{language, link}] ───────────────────

function decodeAnimesaltBundle(rawUrl: string): Array<{ language: string; link: string }> | null {
  const m = rawUrl.match(/[?&]data=([^&]+)/);
  if (!m) return null;
  try {
    const json = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((e: any) => ({ language: String(e?.language || ''), link: String(e?.link || '') }))
      .filter((e) => /^https?:\/\//i.test(e.link));
  } catch {
    return null;
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchServers(anilistId: number, episode: number): Promise<RawServer[]> {
  try {
    const res = await fetchResponse(`${BASE}/api/anilist/${anilistId}/${episode}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `${BASE}/watch/${anilistId}`,
        Origin: BASE,
      },
      signal: AbortSignal.timeout(12000),
    } as RequestInit);
    if (!res.ok) return [];
    const data = (await res.json()) as ServersResponse;
    return Array.isArray(data?.servers) ? data.servers : [];
  } catch {
    return [];
  }
}

/** Expand raw servers into flat playable candidates (animesalt bundles unpacked). */
function flattenServers(servers: RawServer[]): Candidate[] {
  const out: Candidate[] = [];
  for (const s of servers) {
    const url = String(s.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const source = String(s.source || 'animelok');
    const server = String(s.server || 'server');
    const type = String(s.type || '');

    const bundle = decodeAnimesaltBundle(url);
    if (bundle && bundle.length > 0) {
      for (const entry of bundle) {
        out.push({ url: entry.link, source, server, type, language: entry.language });
      }
    } else {
      out.push({ url, source, server, type, language: s.language ?? null });
    }
  }
  return out;
}

// ── Candidate → SourceResult ───────────────────────────────────────────────────

function sanitize(part: string): string {
  return String(part || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function resolveCandidate(c: Candidate, referer: string): Promise<SourceResult | null> {
  const lang = langFor(c.language, c.type);
  // Keep each decoded animesalt language a distinct source key — the three
  // abyssplayer embeds share source/server/type and differ only by language, so
  // without the suffix the UI would collapse them into one selectable server.
  const langSuffix = c.language ? `-${sanitize(c.language)}` : '';
  const sourceKey = `animelok-${sanitize(c.source)}-${sanitize(c.server)}${c.type ? `-${sanitize(c.type)}` : ''}${langSuffix}`;
  const baseHeaders: Record<string, string> = { Referer: referer, 'User-Agent': UA };

  let finalUrl = c.url;
  let sourceType: SourceResult['sourceType'] = 'custom';
  let headers = baseHeaders;
  let subtitles: SubtitleTrack[] = [];
  let quality = '';

  if (/flixcloud\./i.test(c.url)) {
    // Same upstream as the `reanime` provider — decrypt to a direct HLS stream.
    const resolved = await resolveFlixCloud(c.url, fetchResponse).catch(() => null);
    if (resolved?.url) {
      finalUrl = resolved.url;
      sourceType = detectSourceType(finalUrl);
      subtitles = (resolved.subtitles || []).map((sub) => ({
        url: sub.url,
        label: sub.language || 'Subtitles',
        language: sub.language || 'und',
        default: Boolean(sub.isDefault),
      }));
    }
  } else {
    const resolved = await resolveToDirectOrEmbed(c.url, referer).catch(() => null);
    if (resolved) {
      finalUrl = resolved.url;
      sourceType = resolved.sourceType;
      if (resolved.headers) headers = { 'User-Agent': UA, ...resolved.headers };
      if (resolved.quality) quality = resolved.quality;
    }
  }

  if (!/^https?:\/\//i.test(finalUrl)) return null;

  return {
    source: sourceKey,
    url: finalUrl,
    quality: normalizeQuality(quality || (sourceType === 'hls' ? 'auto' : '')),
    headers,
    subtitles,
    audioLanguage: lang.code === 'und' ? undefined : lang.code,
    language: lang.name,
    server: c.server,
    sourceType,
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const animelok: StreamProvider = {
  name: 'animelok',
  sites: [BASE],

  async single(opts: SourceOptions): Promise<SourceResult[]> {
    if (!opts.anilistId) return [];
    const episode = opts.episode ?? 1;

    const servers = await fetchServers(opts.anilistId, episode);
    const candidates = flattenServers(servers);
    if (candidates.length === 0) return [];

    const referer = `${BASE}/watch/${opts.anilistId}`;
    const resolved = await Promise.all(
      candidates.slice(0, 12).map((c) => resolveCandidate(c, referer).catch(() => null)),
    );

    const seen = new Set<string>();
    const out: SourceResult[] = [];
    for (const r of resolved) {
      if (!r || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
    return out;
  },

  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    return animelok.single({ ...opts, episode: opts.episode ?? 1 });
  },
};

export default animelok;
