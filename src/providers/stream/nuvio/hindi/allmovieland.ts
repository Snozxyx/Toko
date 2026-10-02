/**
 * AllMovieLand — Multi-audio WordPress scraper on allmovieland.art
 *
 * The old `.io` host 301-chains away (`.io`→`.you`→`.one`→`.art`); `.art` is the
 * live terminus, so this points there directly to skip the redirect hops.
 *
 * Search strategy: POST form search, pick best title match. The player uses an
 * AWS-hosted stream domain and token-based playlist. Each quality stream has its
 * own file key; for TV the structure is season → episode → file list.
 */

import { createNuvioProvider, type NuvioContext, type NuvioStream } from '../adapter.js';
import {
  siteFetchText,
  siteFetchHtml,
  scoreTitleMatch,
  isAborted,
  isBudgetExhausted,
  HI_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
  NUVIO_UA,
} from '../shared.js';

const SITE = 'https://allmovieland.art';
const LABEL = 'AllMovieLand';

const SITE_HEADERS = {
  'User-Agent': NUVIO_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// ── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  href: string;
  year: number | null;
}

interface PlaylistFile {
  title?: string;
  file?: string;
  folder?: PlaylistFile[];
  id?: number | string;
  episode?: number | string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inferLanguage(text: string): string {
  const t = String(text || '').toLowerCase();
  const langs: string[] = [];
  if (t.includes('hindi')) langs.push('Hindi');
  if (t.includes('tamil')) langs.push('Tamil');
  if (t.includes('telugu')) langs.push('Telugu');
  if (t.includes('english') || /\beng\b/.test(t)) langs.push('English');
  if (langs.length > 2) return 'MULTI';
  if (langs.length === 2) return 'DUAL';
  if (langs.length === 1) return langs[0].toUpperCase();
  if (t.includes('dual')) return 'DUAL';
  if (t.includes('multi')) return 'MULTI';
  return 'HINDI';
}

// ── Search ───────────────────────────────────────────────────────────────────

async function searchSite(
  query: string,
  ctx: NuvioContext
): Promise<SearchResult[]> {
  const searchUrl = `${SITE}/index.php?story=${encodeURIComponent(query)}&do=search&subaction=search`;
  const html = await siteFetchHtml(searchUrl, {
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const results: SearchResult[] = [];
  html('article.short-mid').each((_, el) => {
    const title = html(el).find('a > h3').text().trim();
    const href = html(el).find('a').attr('href') || '';
    if (!title || !href) return;
    const yearMatch = title.match(/\((\d{4})\)/);
    results.push({
      title,
      href,
      year: yearMatch ? parseInt(yearMatch[1], 10) : null,
    });
  });
  return results;
}

// ── Player extraction ────────────────────────────────────────────────────────

async function extractStreams(
  mediaUrl: string,
  mediaType: 'movie' | 'tv',
  season: number | undefined,
  episode: number | undefined,
  ctx: NuvioContext
): Promise<NuvioStream[]> {
  const html = await siteFetchHtml(mediaUrl, {
    acceptLanguage: HI_ACCEPT_LANGUAGE,
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!html) return [];

  const tabsScriptContent = html('div.tabs__content script').html() || '';

  const domainMatch = tabsScriptContent.match(/const AwsIndStreamDomain\s*=\s*'([^']+)'/);
  const playerDomain = domainMatch ? domainMatch[1].replace(/\/$/, '') : null;

  const idMatch = tabsScriptContent.match(/src:\s*'([^']+)'/);
  const id = idMatch ? idMatch[1] : null;

  if (!playerDomain || !id) return [];

  const embedLink = `${playerDomain}/play/${id}`;
  const embedHtml = await siteFetchText(embedLink, {
    headers: { ...SITE_HEADERS, Referer: mediaUrl },
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!embedHtml) return [];

  // Extract p3 JSON from the last script tag
  const p3Match = embedHtml.match(/let\s+p3\s*=\s*(\{.*?\});/s);
  if (!p3Match) return [];

  let p3Data: { file?: string; key?: string };
  try {
    p3Data = JSON.parse(p3Match[1]) as typeof p3Data;
  } catch {
    return [];
  }

  const { file: filePathRaw, key: csrfKey } = p3Data;
  if (!filePathRaw || !csrfKey) return [];

  let fileUrl = filePathRaw.replace(/\\\//g, '/');
  if (!fileUrl.startsWith('http')) fileUrl = `${playerDomain}${fileUrl}`;

  const fileText = await siteFetchText(fileUrl, {
    headers: {
      ...SITE_HEADERS,
      'X-CSRF-TOKEN': csrfKey,
      Referer: embedLink,
    },
    method: 'POST',
    signal: ctx.signal,
    timeoutMs: 12_000,
  });
  if (!fileText) return [];

  let parsedData: PlaylistFile[];
  try {
    parsedData = JSON.parse(fileText.replace(/,\]/g, ']')) as PlaylistFile[];
  } catch {
    return [];
  }

  let targetFiles: PlaylistFile[] = [];

  if (mediaType === 'movie') {
    targetFiles = parsedData.filter((f) => f?.file);
  } else if (mediaType === 'tv' && season != null && episode != null) {
    const seasonData = parsedData.find((s) => {
      const t = String(s.title || '');
      const m = t.match(/Season\s*(\d+)/i) || t.match(/(\d+)\s*Season/i);
      const sNum = m ? parseInt(m[1], 10) : null;
      return sNum === season || String(s.id) === String(season);
    });
    if (seasonData?.folder) {
      const epData = seasonData.folder.find((e) => {
        const t = String(e.title || '');
        const m = t.match(/Episode\s*(\d+)/i) || t.match(/(\d+)\s*Episode/i);
        const eNum = m ? parseInt(m[1], 10) : null;
        return eNum === episode || String(e.episode) === String(episode);
      });
      if (epData?.folder) {
        targetFiles = epData.folder.filter((f) => f?.file);
      }
    }
  }

  if (targetFiles.length === 0) return [];

  const streams: NuvioStream[] = [];

  await Promise.all(
    targetFiles.map(async (fileObj) => {
      if (!fileObj.file) return;
      try {
        const playlistFile = fileObj.file.replace(/^~/, '');
        const playlistUrl = `${playerDomain}/playlist/${playlistFile}.txt`;
        const m3u8Raw = await siteFetchText(playlistUrl, {
          headers: {
            ...SITE_HEADERS,
            'X-CSRF-TOKEN': csrfKey,
            Referer: embedLink,
          },
          method: 'POST',
          signal: ctx.signal,
          timeoutMs: 10_000,
        });
        const m3u8Url = (m3u8Raw ?? '').trim();
        if (!m3u8Url.startsWith('http')) return;

        const qualityStr = fileObj.title || 'Auto';
        const language = inferLanguage(qualityStr);

        streams.push({
          url: m3u8Url,
          name: `${LABEL} | ${qualityStr}`,
          title: `[${language}] ${LABEL} · ${qualityStr}`,
          quality: qualityStr,
          language,
          headers: {
            Referer: `${playerDomain}/`,
            Origin: playerDomain,
            'User-Agent': NUVIO_UA,
          },
        });
      } catch {
        // ignore single failures
      }
    })
  );

  return streams;
}

// ── Main extractor ───────────────────────────────────────────────────────────

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  for (const title of ctx.titles) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const results = await searchSite(title, ctx);
    if (results.length === 0) continue;

    // Pick best match by title score + year proximity
    let bestMatch: SearchResult | null = null;
    let bestScore = -1;
    for (const r of results) {
      let score = scoreTitleMatch(r.title, title);
      if (score > bestScore && score > 30) {
        bestScore = score;
        bestMatch = r;
      }
    }
    if (!bestMatch) continue;

    if (isAborted(ctx.signal) || isBudgetExhausted(startTime, PROVIDER_BUDGET_MS)) break;

    const streams = await extractStreams(
      bestMatch.href,
      ctx.type,
      ctx.season,
      ctx.episode,
      ctx
    );
    if (streams.length > 0) return streams;
  }

  return [];
}

export const allmovieland = createNuvioProvider({
  name: 'allmovieland',
  sites: [SITE],
  language: 'hi',
  extract,
  supportsMovie: true,
  defaultAudioLanguage: 'hi',
});
