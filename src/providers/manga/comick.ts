/**
 * Comick — https://comick.dev (API: https://api.comick.dev)
 *
 * A large public JSON aggregator. Like MangaDex it can map deterministically:
 * a comic's `links.al` / `links.mal` carry the AniList / MAL id when Comick has
 * them, so we prefer an exact id hit and only fall back to fuzzy title match.
 *
 * Its chapter listing is excellent, but Comick de-hosts images for many
 * licensed titles (`md_images` comes back empty), so `getPages` is best-effort:
 * it returns pages when Comick still holds them and an empty list otherwise, at
 * which point the reader's cross-source fallback tries a sibling provider.
 * Images live on `meo.comick.pictures` and want a `Referer`.
 */
import type {
  MangaProvider,
  MangaChapterEntry,
  MangaChapterParams,
  MangaChapterSource,
  MangaPageEntry,
} from '../../types/index.js';

import { fetchJsonWithBypass } from '../../utils/common/fetch-bypass.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

/**
 * Comick rotates its API host roughly yearly (.cc → .io → .fun → .dev …) and the
 * current primary intermittently 502s while its origin is down. A single
 * hardcoded host therefore takes the whole provider offline for weeks at a time.
 * Try the known hosts in order and remember the first that answers with JSON for
 * the rest of the process, so steady-state cost stays at one request.
 */
const API_HOSTS = [
  'https://api.comick.dev',
  'https://api.comick.fun',
  'https://api.comick.io',
  'https://api.comick.art',
  'https://api.comick.live',
];
let preferredHost: string | null = null;

const PROVIDER_NAME = 'comick';
const IMAGE_BASE = 'https://meo.comick.pictures';
const IMAGE_HEADERS = { Referer: 'https://comick.dev/' };
const REQ_HEADERS = { Referer: 'https://comick.dev/' };

/**
 * Fetch an API path, falling over between hosts until one returns usable JSON.
 * `path` begins with `/`. The first host that yields a non-null parse is cached
 * in `preferredHost` and tried first next time.
 */
async function ckJson<T>(path: string, timeoutMs = 12000): Promise<T | null> {
  const ordered = preferredHost
    ? [preferredHost, ...API_HOSTS.filter((h) => h !== preferredHost)]
    : API_HOSTS;

  for (const host of ordered) {
    const res = await fetchJsonWithBypass<T>(`${host}${path}`, {
      timeoutMs,
      headers: REQ_HEADERS,
    });
    if (res != null) {
      preferredHost = host;
      return res;
    }
  }
  return null;
}

interface CkSearchItem {
  hid?: string;
  slug?: string;
  title?: string;
  md_titles?: Array<{ title?: string }>;
  links?: Record<string, string | null> | null;
}

interface CkChapter {
  hid?: string;
  chap?: string | null;
  vol?: string | null;
  title?: string | null;
  lang?: string | null;
  group_name?: string[] | null;
  created_at?: string | null;
}

function candidateNames(it: CkSearchItem): string[] {
  const names = [it.title, ...(it.md_titles ?? []).map((t) => t.title)];
  return names.filter((n): n is string => Boolean(n && n.trim()));
}

/** Order a chapter's sources English-first, then alphabetically by language. */
function orderSources(a: MangaChapterSource, b: MangaChapterSource): number {
  const rank = (l: string) => (l === 'en' ? 0 : 1);
  const r = rank(a.language) - rank(b.language);
  return r !== 0 ? r : a.language.localeCompare(b.language);
}

/** Resolve an AniList/MAL id or titles to a Comick comic hid. Deterministic first. */
async function resolveHid(params: MangaChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;

  const wantAl = Number.isFinite(Number(params.anilistId)) && Number(params.anilistId) > 0
    ? String(params.anilistId) : null;
  const wantMal = Number.isFinite(Number(params.malId)) && Number(params.malId) > 0
    ? String(params.malId) : null;

  const pool: CkSearchItem[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    const res = await ckJson<CkSearchItem[]>(
      `/v1.0/search?q=${encodeURIComponent(title)}&limit=20&type=comic`,
    );
    for (const it of Array.isArray(res) ? res : []) {
      if (!it?.hid || seen.has(it.hid)) continue;
      seen.add(it.hid);
      pool.push(it);
      // Deterministic hit: the AniList/MAL id is stamped on the comic.
      const al = it.links?.al ? String(it.links.al) : null;
      const mal = it.links?.mal ? String(it.links.mal) : null;
      if ((wantAl && al === wantAl) || (wantMal && mal === wantMal)) return it.hid;
    }
  }

  // Comick's catalogue is huge; hold fuzzy matches to a high bar to avoid
  // attaching a wrong title's chapters.
  const best = pickBestMangaCandidate(titles, pool, candidateNames, 0.75);
  return best?.candidate.hid ?? null;
}

const provider: MangaProvider = {
  name: PROVIDER_NAME,
  sites: ['https://comick.dev'],

  async getChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    try {
      const hid = await resolveHid(params);
      if (!hid) return [];

      const byNumber = new Map<number, MangaChapterEntry>();
      const limit = 100;
      let page = 1;
      let total = Infinity;
      let collected = 0;

      // Page through the feed in ALL languages — each language's chapter becomes
      // its own source and the reader picks per chapter. The page cap is raised
      // to absorb the larger all-language listing while still bounding a
      // pathological title.
      while (collected < total && page <= 150) {
        const res = await ckJson<{ chapters?: CkChapter[]; total?: number }>(
          `/comic/${hid}/chapters?chap-order=1&limit=${limit}&page=${page}`,
        );
        const rows = res?.chapters ?? [];
        if (typeof res?.total === 'number') total = res.total;
        if (rows.length === 0) break;

        for (const ch of rows) {
          if (!ch?.hid) continue;
          const num = parseFloat(String(ch.chap ?? ''));
          if (!Number.isFinite(num)) continue;
          const scanlator = Array.isArray(ch.group_name) && ch.group_name.length ? ch.group_name[0] : null;
          const source: MangaChapterSource = {
            provider: PROVIDER_NAME,
            chapterKey: `${PROVIDER_NAME}:${ch.hid}`,
            providerChapterId: ch.hid,
            language: ch.lang ?? 'en',
            scanlator,
            releaseDate: ch.created_at ?? null,
          };
          const existing = byNumber.get(num);
          if (existing) existing.sources.push(source);
          else byNumber.set(num, { number: num, title: ch.title || null, volume: ch.vol ?? null, sources: [source] });
        }

        collected += rows.length;
        page += 1;
      }

      const entries = Array.from(byNumber.values());
      for (const e of entries) e.sources.sort(orderSources);
      return entries.sort((a, b) => a.number - b.number);
    } catch {
      return [];
    }
  },

  async getPages(chapterKey: string): Promise<MangaPageEntry[]> {
    try {
      const colonIdx = chapterKey.indexOf(':');
      const hid = colonIdx >= 0 ? chapterKey.slice(colonIdx + 1) : chapterKey;
      if (!hid) return [];

      const res = await ckJson<{ chapter?: { md_images?: Array<{ b2key?: string; w?: number; h?: number }> } }>(
        `/chapter/${hid}`,
      );
      const images = res?.chapter?.md_images ?? [];
      if (images.length === 0) return [];

      return images
        .filter((img) => Boolean(img?.b2key))
        .map((img, idx) => ({
          pageNumber: idx + 1,
          imageUrl: `${IMAGE_BASE}/${img.b2key}`,
          width: img.w ?? null,
          height: img.h ?? null,
          headers: IMAGE_HEADERS,
        }));
    } catch {
      return [];
    }
  },
};

export default provider;
