/**
 * VAplayer — Multi-language stream aggregator at streamdata.vaplayer.ru.
 *
 * Ported from temp/multi-clone/src/providers/zevran.rs.
 * The API at /api.php accepts an IMDb id and returns stream objects with
 * subtitle tracks. We resolve the IMDb id from TMDB external_ids.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  HI_ACCEPT_LANGUAGE,
} from '../shared.js';

const API_BASE = 'https://streamdata.vaplayer.ru';
const SITE = 'https://nextgencloudfabric.com';
const LABEL = 'VAplayer';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Referer': `${SITE}/`,
  'Origin': SITE,
  'Accept': 'application/json',
};

function pickQuality(fields: string): string {
  const f = fields.toLowerCase();
  if (f.includes('2160') || f.includes('4k') || f.includes('uhd')) return '2160p';
  if (f.includes('1440') || f.includes('2k')) return '1440p';
  if (f.includes('1080') || f.includes('fhd')) return '1080p';
  if (f.includes('720') || f.includes('hd')) return '720p';
  if (f.includes('480')) return '480p';
  return '1080p';
}

interface VaData {
  status_code?: string;
  data?: {
    stream_urls?: unknown;
    stream_url?: unknown;
    default_subs?: Array<{ url?: string; code?: string; lang?: string }>;
  };
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];

  // ani.zip usually carries the IMDb id; the keyless TMDB call is a fallback.
  let imdbId = ctx.imdbId ?? undefined;
  if (!imdbId && ctx.tmdbId) {
    const endpoint = ctx.type === 'tv' ? 'tv' : 'movie';
    const extData = await siteFetchJson<{ imdb_id?: string; external_ids?: { imdb_id?: string } }>(
      `https://api.themoviedb.org/3/${endpoint}/${ctx.tmdbId}?append_to_response=external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = extData?.imdb_id ?? extData?.external_ids?.imdb_id ?? undefined;
  }
  if (!imdbId) return [];

  if (isAborted(ctx.signal)) return [];

  const isTV = ctx.type === 'tv' && ctx.season != null && ctx.episode != null;
  const apiUrl = isTV
    ? `${API_BASE}/api.php?imdb=${imdbId}&type=tv&season=${ctx.season}&episode=${ctx.episode}`
    : `${API_BASE}/api.php?imdb=${imdbId}&type=movie`;

  const data = await siteFetchJson<VaData>(apiUrl, {
    headers: HEADERS,
    timeoutMs: 10_000,
    signal: ctx.signal,
  });

  if (data?.status_code === 'error' || !data?.data) return [];
  const inner = data.data;

  // Collect stream URLs
  const rawItems: unknown[] = [];
  if (Array.isArray(inner.stream_urls)) {
    rawItems.push(...inner.stream_urls);
  } else if (inner.stream_urls && typeof inner.stream_urls === 'object') {
    rawItems.push(...Object.values(inner.stream_urls as Record<string, unknown>));
  } else if (inner.stream_url) {
    rawItems.push(inner.stream_url);
  }

  // Subtitles
  const subs = (inner.default_subs ?? [])
    .filter(s => Boolean(s.url))
    .map(s => ({
      url: s.url!,
      label: s.lang ?? s.code ?? 'Unknown',
      language: s.code ?? s.lang ?? 'und',
    }));

  const streams: NuvioStream[] = [];
  const seen = new Set<string>();

  for (const item of rawItems) {
    let streamUrl: string;
    let fields = '';
    if (typeof item === 'string') {
      streamUrl = item;
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      streamUrl = String(o.url ?? o.file ?? o.src ?? '');
      fields = Object.values(o).join(' ');
    } else continue;

    streamUrl = streamUrl.trim().replace(/\/$/, '');
    if (!streamUrl || seen.has(streamUrl)) continue;
    seen.add(streamUrl);

    const quality = pickQuality(fields + ' ' + streamUrl);
    const s = toStream(streamUrl, 'MULTI', LABEL, SITE, {
      quality,
      headers: HEADERS,
      subtitles: subs,
    });
    streams.push(s);
  }

  return streams;
}

export const vaplayer = createNuvioProvider({
  name: 'vaplayer',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'en',
});
