/**
 * MovieBox (Hindi group) — Cloudflare Worker API at moviebox.s4nch1tt.workers.dev.
 *
 * Ported from temp/HindiAPI/HindiAPI/providers/moviebox.js.
 * A single API call to /streams?tmdb_id=&type=&se=&ep=&proxy= returns stream
 * objects with proxy_url, resolution, codec, and language embedded in the name.
 * We use proxy_url as the stream URL since the worker applies Range headers.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  toStream,
  isAborted,
  HI_ACCEPT_LANGUAGE,
} from '../shared.js';

const WORKER = 'https://moviebox.s4nch1tt.workers.dev';
// siteUrl label only (not fetched); themoviebox.org 301s here. The real backend
// is the Cloudflare worker above.
const SITE = 'https://officialmoviebox.com';
const LABEL = 'MovieBox';

interface WorkerStream {
  url?: string;
  proxy_url?: string;
  name?: string;
  title?: string;
  resolution?: string | number;
  codec?: string;
  format?: string;
  size_mb?: number;
}

function detectLang(name: string): string {
  const m = name.match(/\(([^)]+)\)/);
  if (!m) return 'HINDI';
  const l = m[1].toLowerCase();
  if (l.includes('hindi')) return 'HINDI';
  if (l.includes('tamil')) return 'TAMIL';
  if (l.includes('telugu')) return 'TELUGU';
  if (l.includes('multi') || l.includes('dual')) return 'MULTI';
  return 'HINDI';
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || !ctx.tmdbId) return [];

  let url = `${WORKER}/streams?tmdb_id=${ctx.tmdbId}&type=${ctx.type}&proxy=${encodeURIComponent(WORKER)}`;
  if (ctx.type === 'tv' && ctx.season != null && ctx.episode != null) {
    url += `&se=${ctx.season}&ep=${ctx.episode}`;
  }

  const data = await siteFetchJson<WorkerStream[] | { streams?: WorkerStream[] }>(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Nuvio/1.0' },
    timeoutMs: 10_000,
    signal: ctx.signal,
  });
  if (!data) return [];

  const rawStreams: WorkerStream[] = Array.isArray(data) ? data : (data.streams ?? []);
  if (rawStreams.length === 0) return [];

  return rawStreams
    .map(s => {
      const streamUrl = s.proxy_url ?? s.url ?? '';
      if (!streamUrl) return null;
      const q = s.resolution ? `${String(s.resolution).match(/(\d+)/)?.[1] ?? '720'}p` : '720p';
      const lang = detectLang(s.name ?? '');
      return toStream(streamUrl, lang, LABEL, SITE, { quality: q });
    })
    .filter((s): s is NuvioStream => s !== null);
}

export const movieboxhindi = createNuvioProvider({
  name: 'movieboxhindi',
  sites: [SITE],
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
