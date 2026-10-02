/**
 * ani.pm — https://ani.pm  (React SPA backed by a JSON API under /api)
 *
 * ani.pm indexes by AniList ID, so in the common case resolution needs NO title
 * search:
 *   GET /api/anime/playback-bootstrap/anilist/{anilistId}?ep={N}&lang=sub&backup=1
 * returns JSON including:
 *   availability: { sub, dub }
 *   backupEmbed:  { available, url, language, direct: { stream } }
 *     - url           → external embed, e.g. https://megaplay.buzz/stream/mal/{malId}/{ep}/sub
 *     - direct.stream → https://embed.settlar.io/backup/v1/stream?t=…  (origin-locked)
 *
 * HARDSUB: ani.pm's "sub" track is English DUBTITLES burned into the video, so
 * we report the original audio (audioLanguage 'ja') and flag the burned-in text
 * ONLY in the human label: language 'English (Dubtitles)'.
 *
 * CONFIRMED (clean-IP fingerprint 2026-10):
 *   - the AniList path uses the AniList id (verified 113415 -> JJK, mapped
 *     server-side to megaplay.buzz/stream/mal/40748/{ep}/sub).
 *   - the PRIMARY ani.pm player streams a token-signed, encrypted m3u8 under
 *     /api/anime/anipm-server/* whose key is not in the bootstrap payload, so we
 *     surface the backup embeds instead (the app's embed resolver plays
 *     megaplay / settlar). megaplay's /stream/getSources exposes a soft English
 *     subtitle .vtt which we attach as a bonus track.
 *
 * best-effort: unverified — the title-search fallback (/api/anime/search ->
 *   playback-bootstrap/{source}/{id}) response shapes are assumed from the SPA
 *   bundle; the AniList path above is the confirmed primary route.
 *
 * Transport: plain fetch (JSON API, no Cloudflare challenge on a clean IP).
 */
import { normalizeQuality } from '../../utils/scraping/quality.js';
import { buildSearchQueries, scoreMatch } from '../../utils/scraping/title-normalizer.js';
import type { StreamProvider, SourceOptions, SourceResult, SubtitleTrack } from '../../types/index.js';
import { fetchJson, fetchText } from '../../utils/http/fetch.js';
import { resolveToDirectOrEmbed } from '../../utils/resolvers/index.js';

const SITE = 'https://ani.pm';
const API = `${SITE}/api`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function apiHeaders(): Record<string, string> {
  return { 'User-Agent': UA, Accept: 'application/json', Referer: `${SITE}/`, 'X-Requested-With': 'XMLHttpRequest' };
}
interface Bootstrap {
  availability?: { sub?: boolean; dub?: boolean };
  core?: { id?: number; title?: string };
  backupEmbed?: {
    available?: boolean;
    url?: string;
    language?: string;
    direct?: { stream?: string };
  };
}

interface SearchResp {
  items?: Array<{ id: number; source?: string; title?: string; romaji?: string; native?: string }>;
  results?: Array<{ id: number; source?: string; title?: string; romaji?: string; native?: string }>;
}

async function bootstrap(source: string, id: string | number, ep: number): Promise<Bootstrap | null> {
  const url = `${API}/anime/playback-bootstrap/${source}/${encodeURIComponent(String(id))}?ep=${encodeURIComponent(String(ep))}&lang=sub&backup=1`;
  return fetchJson<Bootstrap>(url, { headers: apiHeaders(), timeoutMs: 12000 });
}

/** megaplay backup embed exposes a soft English subtitle via /stream/getSources?id=… */
async function megaplaySubtitles(embedUrl: string): Promise<SubtitleTrack[]> {
  try {
    const page = await fetchText(embedUrl, { headers: { 'User-Agent': UA, Referer: `${SITE}/` }, timeoutMs: 8000 });
    const id = page?.match(/data-id=["'](\d+)["']/i)?.[1];
    if (!id) return [];
    const origin = new URL(embedUrl).origin;
    const data = await fetchJson<{ tracks?: Array<{ file: string; label?: string; kind?: string; default?: boolean }> }>(
      `${origin}/stream/getSources?id=${id}`,
      { headers: { 'User-Agent': UA, Referer: embedUrl, 'X-Requested-With': 'XMLHttpRequest' }, timeoutMs: 8000 },
    );
    return (data?.tracks ?? [])
      .filter((t) => t.file && (t.kind === 'captions' || t.kind === 'subtitles' || !t.kind))
      .map((t) => ({ url: t.file, label: t.label || 'English', language: 'en', default: t.default }));
  } catch {
    return [];
  }
}
async function sourcesFromBootstrap(b: Bootstrap, subtitles: SubtitleTrack[]): Promise<SourceResult[]> {
  const out: SourceResult[] = [];
  const be = b.backupEmbed;
  // ani.pm's backups are origin-locked; send Origin+Referer for the embed/passthrough.
  const siteHeaders = { Referer: `${SITE}/`, Origin: SITE, 'User-Agent': UA };

  // Try to pull a direct m3u8/mp4 out of the embed; keep the embed as a fallback.
  const add = async (embedUrl: string, server: string, subs: SubtitleTrack[]): Promise<void> => {
    const r = await resolveToDirectOrEmbed(embedUrl, `${SITE}/`);
    if (!r) return;
    const headers = r.url !== embedUrl && r.headers ? { 'User-Agent': UA, ...r.headers } : siteHeaders;
    out.push({
      source: `anipm-${server}-ja`,
      url: r.url,
      quality: normalizeQuality(r.quality ?? ''),
      headers,
      audioLanguage: 'ja',
      language: 'English (Dubtitles)', // burned-in dubtitles flagged here only
      server,
      subtitles: subs,
      refererCandidates: [`${SITE}/`],
      sourceType: r.sourceType,
    });
  };

  if (be?.url && /^https?:\/\//.test(be.url)) await add(be.url, 'megaplay', subtitles);
  if (be?.direct?.stream && /^https?:\/\//.test(be.direct.stream)) await add(be.direct.stream, 'settlar', []);
  return out;
}

const provider: StreamProvider = {
  name: 'anipm',
  sites: [SITE],
  async single(opts: SourceOptions): Promise<SourceResult[]> {
    try {
      const ep = opts.episode ?? 1;

      // Preferred: direct AniList-id resolution (no search needed).
      let b: Bootstrap | null = null;
      if (opts.anilistId) b = await bootstrap('anilist', opts.anilistId, ep);

      // Fallback: title search -> playback-bootstrap on the hit's native id.
      if (!b?.backupEmbed?.available) {
        for (const q of buildSearchQueries(opts.titles).slice(0, 2)) {
          const res = await fetchJson<SearchResp>(`${API}/anime/search?q=${encodeURIComponent(q)}`, {
            headers: apiHeaders(),
            timeoutMs: 10000,
          });
          const items = res?.items ?? res?.results ?? [];
          if (!items.length) continue;
          const best = items
            .map((it) => ({ it, score: scoreMatch(q, it.romaji || it.title || it.native || '') }))
            .sort((a, c) => c.score - a.score)[0];
          if (!best || best.score < 0.4) continue;
          b = await bootstrap(best.it.source || 'anilist', best.it.id, ep);
          if (b?.backupEmbed?.available) break;
        }
      }

      if (!b?.backupEmbed?.available) return [];
      const subs = b.backupEmbed.url ? await megaplaySubtitles(b.backupEmbed.url) : [];
      return await sourcesFromBootstrap(b, subs);
    } catch {
      return [];
    }
  },
};

export default provider;
