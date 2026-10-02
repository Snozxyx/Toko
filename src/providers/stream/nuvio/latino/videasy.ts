/**
 * Videasy — Multi-server encrypted API at api.videasy.net.
 *
 * Ported from temp/Latino/Latino/providers/videasy.js.
 * Three servers each have an endpoint that returns an encrypted response. The
 * response is decrypted via enc-dec.app/api/dec-videasy by posting the
 * ciphertext + TMDB id. The decrypted JSON carries `.sources[].url`. We query
 * all servers concurrently and aggregate the streams.
 *
 * The Gekko (Cuevana) server on api2.videasy.net was dropped: that host is
 * NXDOMAIN (the same deadness that removed the brazucaplay provider, which
 * relied on it as its sole endpoint).
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchText,
  siteFetchJson,
  toStream,
  isAborted,
  isBudgetExhausted,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://player.videasy.to';
const LABEL = 'Videasy';
const API_DEC = 'https://enc-dec.app/api/dec-videasy';

const CINEBY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 OPR/126.0.0.0 (Edition std-2)';
const ANDROID_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  'Referer': 'https://player.videasy.to/',
  'Origin': 'https://player.videasy.to',
};

const SERVERS: Array<{ id: string; url: string; label: string; lang: string; useAndroidHeaders?: boolean }> = [
  { id: 'Omen',   url: 'https://api.videasy.net/lamovie/sources-with-title',  label: 'L-Movie',   lang: 'LAT' },
  { id: 'Vimeos', url: 'https://api.videasy.net/vimeos/sources-with-title',   label: 'Vimeos',    lang: 'LAT' },
  { id: 'Raze',   url: 'https://api.videasy.net/superflix/sources-with-title',label: 'Superflix', lang: 'LAT', useAndroidHeaders: true },
];

async function queryServer(
  server: typeof SERVERS[0],
  ctx: NuvioContext,
  title: string,
  year: string,
): Promise<NuvioStream[]> {
  const doubleEncTitle = encodeURIComponent(encodeURIComponent(title));
  let searchUrl =
    `${server.url}?title=${doubleEncTitle}&mediaType=${ctx.type}&year=${year}&tmdbId=${ctx.tmdbId ?? ''}`;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    searchUrl += `&episodeId=${ctx.episode}&seasonId=${ctx.season}`;
  }

  const reqHeaders = {
    'Accept': '*/*',
    'Origin': 'https://cineby.sc',
    'Referer': 'https://cineby.sc/',
    'User-Agent': CINEBY_UA,
  };

  const encText = await siteFetchText(searchUrl, {
    headers: reqHeaders,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!encText || encText.length < 20) return [];

  const decData = await siteFetchJson<{ result?: { sources?: Array<{ url?: string; quality?: string }> } }>(
    API_DEC,
    {
      method: 'POST',
      body: JSON.stringify({ text: encText, id: String(ctx.tmdbId ?? '') }),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CINEBY_UA,
      },
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!decData?.result?.sources) return [];

  const streams: NuvioStream[] = [];
  for (const source of decData.result.sources) {
    if (!source.url) continue;
    let quality = (source.quality ?? 'HD').toUpperCase();
    if (quality === 'AUTO') quality = '1080p';

    const h = server.useAndroidHeaders ? ANDROID_HEADERS : reqHeaders;
    streams.push(toStream(source.url, server.lang, LABEL, SITE, {
      quality,
      server: server.label,
      headers: h,
    }));
  }
  return streams;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  // We use ctx.titles[0] as the title for the Videasy API
  const title = ctx.titles[0];
  // Year is not available in ctx directly, use empty string as fallback
  const year = '';

  const results = await Promise.allSettled(
    SERVERS.map(server => queryServer(server, ctx, title, year))
  );

  const streams: NuvioStream[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') streams.push(...r.value);
  }
  return streams;
}

export const videasy = createNuvioProvider({
  name: 'videasy',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
