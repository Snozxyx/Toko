/**
 * FuegoCine — Blogspot-based Latin American streaming site at fuegocine.com.
 *
 * Ported from temp/Latino/Latino/providers/fuegocine.js.
 * The site is a Blogspot blog; content is found via the Blogger JSON feeds API
 * (/feeds/posts/default?alt=json&q=TITLE). Each post's HTML contains a
 * `_SV_LINKS` JS array with objects that carry `lang` and embed URL fields.
 * Links may be wrapped in ?r= or ?link= redirect parameters.
 */

import { createNuvioProvider, type NuvioStream, type NuvioContext } from '../adapter.js';
import {
  siteFetchJson,
  siteFetchText,
  resolveEmbedsUntil,
  isAborted,
  isBudgetExhausted,
  decodeBase64,
  normalize,
  ES_ACCEPT_LANGUAGE,
  PROVIDER_BUDGET_MS,
} from '../shared.js';

const SITE = 'https://www.fuegocine.com';
const LABEL = 'FuegoCine';

interface BlogEntry {
  content?: { $t?: string };
  title?: { $t?: string };
}

function decodeUrl(url: string): string {
  if (!url) return '';
  const b64Match = url.match(/[?&]r=([A-Za-z0-9+/=]{10,})/);
  if (b64Match) {
    const dec = decodeBase64(b64Match[1]);
    if (dec) return decodeUrl(dec);
  }
  const linkMatch = url.match(/[?&]link=([^&]+)/);
  if (linkMatch) {
    const dec = decodeURIComponent(linkMatch[1]);
    if (dec) return decodeUrl(dec);
  }
  const driveMatch = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([A-Za-z0-9_-]+)/);
  if (driveMatch) {
    return `https://drive.usercontent.google.com/download?id=${driveMatch[1]}&export=download&confirm=t`;
  }
  return url;
}

function langTag(lang: string): string {
  const l = lang.toLowerCase();
  if (l.includes('cast') || l.includes('esp')) return 'CAST';
  if (l.includes('sub') || l.includes('vose')) return 'SUB';
  return 'LAT';
}

function extractSvLinks(html: string): Array<{ lang: string; url: string; server?: string }> {
  const links: Array<{ lang: string; url: string; server?: string }> = [];
  const match = html.match(/const\s+_SV_LINKS\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!match) return links;

  const entryRe = /\{[^{}]+\}/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(match[1])) !== null) {
    try {
      const entry = m[0]
        .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')  // unquoted keys → quoted
        .replace(/'/g, '"');
      const obj = JSON.parse(entry) as Record<string, string>;
      const lang = obj.lang ?? obj.language ?? 'lat';
      const url = obj.url ?? obj.src ?? obj.link ?? '';
      if (url) links.push({ lang, url: decodeUrl(url), server: obj.server ?? obj.host });
    } catch {
      // Entry couldn't be parsed — skip
    }
  }
  return links;
}

async function extract(ctx: NuvioContext): Promise<NuvioStream[]> {
  if (isAborted(ctx.signal) || ctx.titles.length === 0) return [];
  const startTime = Date.now();

  const query = encodeURIComponent(ctx.titles[0]);
  const feedUrl = `${SITE}/feeds/posts/default?alt=json&max-results=10&q=${query}`;

  const feed = await siteFetchJson<{ feed?: { entry?: BlogEntry[] } }>(feedUrl, {
    acceptLanguage: ES_ACCEPT_LANGUAGE,
    timeoutMs: 8_000,
    signal: ctx.signal,
  });
  if (!feed?.feed?.entry?.length) return [];

  const entries = feed.feed.entry;
  const targetNorm = normalize(ctx.titles[0]);

  // Pick the best matching entry
  let bestEntry: BlogEntry | null = null;
  for (const entry of entries) {
    const entryTitle = normalize(entry.title?.$t ?? '');
    if (entryTitle.includes(targetNorm) || targetNorm.includes(entryTitle)) {
      bestEntry = entry;
      break;
    }
  }
  if (!bestEntry) bestEntry = entries[0];

  const content = bestEntry.content?.$t ?? '';
  if (!content) return [];

  if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) return [];

  const svLinks = extractSvLinks(content);

  // Also try iframe embeds directly in content
  const iframeRe = /src="(https?:\/\/[^"]+)"/g;
  let im: RegExpExecArray | null;
  while ((im = iframeRe.exec(content)) !== null) {
    const url = im[1];
    if (!svLinks.some(l => l.url === url)) {
      svLinks.push({ lang: 'lat', url });
    }
  }

  if (svLinks.length === 0) return [];

  // Group by language and resolve each group
  const streams: NuvioStream[] = [];
  const langGroups = new Map<string, string[]>();
  for (const { lang, url } of svLinks) {
    const tag = langTag(lang);
    if (!langGroups.has(tag)) langGroups.set(tag, []);
    langGroups.get(tag)!.push(url);
  }

  for (const [tag, urls] of langGroups) {
    if (isAborted(ctx.signal) || isBudgetExhausted(startTime)) break;
    const embeds = urls.map(url => ({ url, language: tag }));
    const resolved = await resolveEmbedsUntil(embeds, {
      language: tag,
      providerLabel: LABEL,
      siteUrl: SITE,
      signal: ctx.signal,
      budgetMs: 8_000,
    });
    streams.push(...resolved);
  }

  return streams;
}

export const fuegocine = createNuvioProvider({
  name: 'fuegocine',
  sites: [SITE],
  language: 'es',
  extract,
  supportsMovie: true,
});
