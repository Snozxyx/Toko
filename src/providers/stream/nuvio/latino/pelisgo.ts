/**
 * PelisGo — Latin American streaming site at pelisgo.online.
 *
 * Ported from temp/Latino/Latino/providers/pelisgo.js.
 * Uses an IMDB-id-based API. The page HTML contains JSON-like server objects
 * with server/url/quality/language fields. Only whitelisted server families
 * (Magi, Filemoon, Pixeldrain) are used.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://pelisgo.online';
const LABEL = 'PelisGo';
const WHITELIST = ['magi', 'filemoon', 'pixeldrain'];

function langTag(lang: string): string {
  const l = (lang ?? '').toLowerCase();
  if (l.includes('cast') || l.includes('españa')) return 'CAST';
  if (l.includes('sub')) return 'SUB';
  return 'LAT';
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal)) return [];
  const startTime = Date.now();

  // ani.zip usually carries the IMDb id already; only hit TMDB (keyless, so
  // best-effort) when it did not, and that needs a TMDB id to query.
  let imdbId = ctx.imdbId ?? undefined;
  if (!imdbId && ctx.tmdbId) {
    const tmdbEndpoint = ctx.type === 'tv' ? 'tv' : 'movie';
    const extData = await siteFetchJson<{ imdb_id?: string }>(
      `https://api.themoviedb.org/3/${tmdbEndpoint}/${ctx.tmdbId}/external_ids`,
      { timeoutMs: 5_000, signal: ctx.signal }
    );
    imdbId = extData?.imdb_id ?? undefined;
  }
  if (!imdbId) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  // Build search URL using IMDB id
  const searchUrl = `${SITE}/api/source/${imdbId}${ctx.type === 'tv' && ctx.season != null ? `?season=${ctx.season}&episode=${ctx.episode ?? 1}` : ''}`;

  const raw = await siteFetchText(searchUrl, {
    headers: {
      Referer: `${SITE}/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!raw) return [];

  // Parse server objects from the raw JSON-like HTML
  const serverObjs = raw.match(/\{[^{}]*?server[\\"' ]+:[\\"' ]+[^{}]*?\}/gis) ?? [];
  const embeds: Array<{ url: string; language: string }> = [];
  const seen = new Set<string>();

  for (const objStr of serverObjs) {
    const sM = objStr.match(/server[\\"' ]+:[\\"' ]+([^\\"' ,}]+)/i);
    const uM = objStr.match(/(?:url|download)[\\"' ]+:[\\"' ]+([^\\"' ,}]+)/i);
    if (!sM || !uM) continue;

    const serverName = sM[1].toLowerCase();
    if (!WHITELIST.some(w => serverName.includes(w))) continue;

    const rawUrl = uM[1].replace(/\\/g, '');
    if (!rawUrl.startsWith('http') || seen.has(rawUrl)) continue;
    seen.add(rawUrl);

    const lM = objStr.match(/language[\\"' ]+:[\\"' ]+([^\\"' ,}]+)/i);
    embeds.push({ url: rawUrl, language: langTag(lM?.[1] ?? 'latino') });
  }

  if (embeds.length === 0) return [];

  return resolveEmbedsUntil(embeds, {
    language: 'LAT',
    providerLabel: LABEL,
    siteUrl: SITE,
    signal: ctx.signal,
    budgetMs: PROVIDER_BUDGET_MS - (Date.now() - startTime),
  });
}

export const pelisgo = createNuvioProvider({
  name: 'pelisgo',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
