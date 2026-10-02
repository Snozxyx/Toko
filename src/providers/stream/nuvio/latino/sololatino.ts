/**
 * SoloLatino — IMDB-keyed player at sololatino.net.
 *
 * Ported from temp/Latino/Latino/providers/sololatino.js.
 * The player backend at player.pelisserieshoy.com serves a page whose JS
 * contains a token needed to POST to /s.php for the direct stream URL. We need
 * an IMDB id to build the /f/IMDBID[–SxEE] path, but since ctx only carries a
 * TMDB id we call TMDB's external_ids endpoint once to get the IMDB id.
 *
 * ⚠ DEPLOYMENT-VERIFY (2026-10): player.pelisserieshoy.com now 302s to
 * google.com — that hardcoded player host is dead and this provider yields no
 * streams until PLAYER is repointed. sololatino.net itself is alive (bot-walled
 * from this CI, so the current embed host can't be rediscovered here). In your
 * deployment, scrape a sololatino.net watch page for the live player origin and
 * update PLAYER below.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  toStream,
  isAborted,
  isBudgetExhausted,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://sololatino.net';
const PLAYER = 'https://player.pelisserieshoy.com';
const LABEL = 'SoloLatino';

const HEADERS = {
  'User-Agent': NUVIO_UA,
  'Accept': '*/*',
  'Accept-Language': ES_ACCEPT_LANGUAGE,
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': `${SITE}/`,
};

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  // ani.zip usually supplies the IMDb id; the keyless TMDB call is a fallback.
  let imdbId = ctx.imdbId ?? undefined;
  if (!imdbId && ctx.tmdbId) {
    const tmdbEndpoint = ctx.type === 'tv' ? 'tv' : 'movie';
    const extData = await siteFetchJson<{ imdb_id?: string; external_ids?: { imdb_id?: string } }>(
      `https://api.themoviedb.org/3/${tmdbEndpoint}/${ctx.tmdbId}/external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = extData?.imdb_id ?? extData?.external_ids?.imdb_id ?? undefined;
  }
  if (!imdbId) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // Build player URL
  let slug = imdbId;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    const epStr = String(ctx.episode).padStart(2, '0');
    slug = `${imdbId}-${ctx.season}x${epStr}`;
  }
  const playerUrl = `${PLAYER}/f/${slug}`;

  const html = await siteFetchText(playerUrl, {
    headers: HEADERS,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!html) return [];

  // Extract token from the player page
  const tokenMatch = html.match(/(?:let\s+token|const\s+_t|tok|_t|token)\s*.*['"]([a-f0-9]{32})['"]/);
  if (!tokenMatch) return [];
  const token = tokenMatch[1];

  // POST to /s.php to get stream URL
  const body = `a=2&v=${imdbId}&tok=${token}`;
  const data = await siteFetchJson<{ u?: string; sig?: string }>(
    `${PLAYER}/s.php`,
    {
      method: 'POST',
      body,
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Referer': playerUrl,
      },
      timeoutMs: 8_000,
      signal: ctx.signal,
    }
  );
  if (!data?.u) return [];

  let videoUrl = data.u;
  if (data.sig) {
    videoUrl = `${PLAYER}/p.php?url=${encodeURIComponent(data.u)}&sig=${data.sig}`;
  }

  return [toStream(videoUrl, 'LAT', LABEL, SITE, { quality: '1080p' })];
}

export const sololatino = createNuvioProvider({
  name: 'sololatino',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
