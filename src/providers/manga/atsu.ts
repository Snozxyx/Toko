/**
 * Atsu — https://atsu.moe (API on the same origin, CDN on cdn.atsu.moe)
 *
 * A clean JSON reader with no Cloudflare, no auth and no anti-bot: search,
 * chapter list and page list are all plain `/api/...` GETs. It indexes a lot of
 * Korean/Chinese webtoons the Japanese-manga catalogues miss, so it is the
 * provider that fills the manhwa gap (Solo Leveling, SSS-Class, …).
 *
 * No AniList id anywhere in the payloads, so mapping is fuzzy title match via
 * the shared resolver — search hits carry `title` + a large `otherNames` list.
 * `medium` distinguishes "Comic" from "Novel"; only Comics are kept so a light
 * novel never gets mapped onto a manga entry.
 *
 * Pages return a site-relative `image` path (`/static/pages/...`) that
 * 301-redirects to `cdn.atsu.moe`; emitting the CDN URL directly skips the hop.
 * The CDN applies Referer hotlink protection: a browser `<img>` load sends the
 * app's own origin as Referer and gets a 403, so each page carries an
 * `atsu.moe` Referer and the host proxies the fetch server-side.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchJson } from '../../utils/http/fetch.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://atsu.moe';
const CDN = 'https://cdn.atsu.moe';
const PROVIDER_NAME = 'atsu';

interface AtsuDoc {
  id: string;
  title?: string;
  otherNames?: string[];
  medium?: string; // "Comic" | "Novel" | …
  chapterCount?: number;
  isAdult?: boolean;
}

interface AtsuChapter {
  id: string;
  title?: string | null;
  number?: number;
  createdAt?: number | null;
  pageCount?: number;
}

interface AtsuPage {
  image?: string; // "/static/pages/<mangaId>/<chapterId>/<n>.webp"
  number?: number;
}

/** All searchable names for a hit — canonical title plus every localized alias. */
function docNames(d: AtsuDoc): string[] {
  const names: string[] = [];
  if (d.title) names.push(d.title);
  for (const n of d.otherNames ?? []) if (n) names.push(n);
  return names;
}

/** Query Atsu's Typesense-backed search, keeping only comics (never novels). */
async function search(query: string): Promise<AtsuDoc[]> {
  const url = `${BASE}/api/search/manga?q=${encodeURIComponent(query)}&query_by=title`;
  const res = await fetchJson<{ hits?: Array<{ document?: AtsuDoc }> }>(url, { timeoutMs: 12000 });
  const docs: AtsuDoc[] = [];
  for (const hit of res?.hits ?? []) {
    const d = hit?.document;
    if (d?.id && (d.medium ?? 'Comic') !== 'Novel') docs.push(d);
  }
  return docs;
}

/** Resolve an AniList id / titles to an Atsu manga id via fuzzy title match. */
async function resolveMangaId(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const seen = new Set<string>();
  const pool: AtsuDoc[] = [];
  for (const title of titles.slice(0, 2)) {
    for (const doc of await search(title)) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        pool.push(doc);
      }
    }
  }

  const best = pickBestMangaCandidate(titles, pool, (d) => docNames(d), 0.6);
  return best ? best.candidate.id : null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const mangaId = await resolveMangaId(params);
      if (!mangaId) return [];

      const res = await fetchJson<{ chapters?: AtsuChapter[] }>(
        `${BASE}/api/manga/allChapters?mangaId=${encodeURIComponent(mangaId)}`,
        { timeoutMs: 12000 },
      );
      const rows = res?.chapters ?? [];
      if (rows.length === 0) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      for (const ch of rows) {
        const num = Number(ch.number);
        if (!ch.id || !Number.isFinite(num) || byNumber.has(num)) continue;

        // Atsu's read endpoint needs both ids, so the key carries both:
        // `atsu:<mangaId>|<chapterId>`. getPages splits them back out.
        const source: MangaChapterSource = {
          provider: PROVIDER_NAME,
          chapterKey: `${PROVIDER_NAME}:${mangaId}|${ch.id}`,
          providerChapterId: ch.id,
          language: 'en',
          scanlator: null,
          releaseDate: ch.createdAt ? new Date(ch.createdAt).toISOString() : null,
        };
        byNumber.set(num, {
          number: num,
          title: ch.title || null,
          volume: null,
          sources: [source],
        });
      }

      return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const rest = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      const [mangaId, chapterId] = rest.split('|');
      if (!mangaId || !chapterId) return [];

      const res = await fetchJson<{ readChapter?: { pages?: AtsuPage[] } }>(
        `${BASE}/api/read/chapter?mangaId=${encodeURIComponent(mangaId)}&chapterId=${encodeURIComponent(chapterId)}`,
        { timeoutMs: 15000 },
      );
      const raw = res?.readChapter?.pages ?? [];
      if (raw.length === 0) return [];

      // `image` is the CDN redirect target once prefixed with the CDN origin;
      // sort by the page's own `number` so the reader gets them in order. The
      // CDN 403s any Referer that isn't atsu.moe, so attach one — the host sees
      // `headers` and routes the image through the in-app proxy.
      const pages = raw
        .filter((p): p is AtsuPage & { image: string } => Boolean(p.image))
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
        .map((p, idx) => ({
          pageNumber: idx + 1,
          imageUrl: p.image.startsWith('http') ? p.image : `${CDN}${p.image}`,
          headers: { Referer: `${BASE}/`, Origin: BASE },
        }));

      return pages;
    } catch {
      return [];
    }
  },
};

export default provider;
