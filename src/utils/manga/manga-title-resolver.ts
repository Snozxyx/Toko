/**
 * Manga title resolution + fuzzy candidate matching.
 *
 * The manga providers (AllManga, Mangaball) only expose title search — they
 * have no AniList id. To map an AniList id onto them we first resolve the id
 * to its full set of titles + synonyms via the AniList GraphQL API
 * (`type: MANGA`), then fuzzy-match those against each provider's search hits.
 *
 * MangaDex is the exception: its API carries the AniList id directly
 * (`attributes.links.al`), so it maps deterministically and only falls back to
 * this fuzzy path when the id link is absent.
 */

import { fetchResponse } from '../http/fetch.js';
import { normalizeTitle, scoreMatch } from '../scraping/title-normalizer.js';
import type { MangaChapterParams } from '../../types/index.js';

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';

/** Latin letters/digits/punctuation only — drop CJK/Hangul/Cyrillic synonyms. */
const LATIN_ONLY_RE = /^[\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\p{S}]+$/u;

// AniList id → resolved titles, cached for the worker's lifetime. Manga titles
// never change, so a permanent per-process cache is safe and spares the ~5 s
// GraphQL round trip on every provider fan-out.
const titleCache = new Map<number, string[]>();

/**
 * Resolve a manga's search titles from an AniList id (falling back to the
 * caller-supplied `title`). Returns a de-duplicated, best-first list:
 * english → romaji → userPreferred → native → Latin synonyms (capped).
 */
export async function resolveMangaTitles(params: MangaChapterParams): Promise<string[]> {
  // Caller already resolved them (bundle enriches once before fan-out).
  if (params.titles && params.titles.length > 0) return params.titles;

  const fallback = params.title ? [params.title] : [];
  const anilistId = Number(params.anilistId);
  if (!Number.isFinite(anilistId) || anilistId <= 0) return fallback;

  if (titleCache.has(anilistId)) return titleCache.get(anilistId)!;

  try {
    const res = await fetchResponse(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: `query ($id: Int) {
          Media(id: $id, type: MANGA) {
            title { english romaji userPreferred native }
            synonyms
          }
        }`,
        variables: { id: anilistId },
      }),
      timeoutMs: 8000,
    });
    if (!res.ok) return fallback;

    const data = (await res.json()) as {
      data?: { Media?: { title?: Record<string, string | null>; synonyms?: string[] } };
    };
    const media = data?.data?.Media;
    if (!media) return fallback;

    const t = media.title ?? {};
    const primary = [t.english, t.romaji, t.userPreferred, t.native].filter(
      (v): v is string => Boolean(v && v.trim()),
    );
    // Only Latin synonyms are useful search queries, and only a couple — the
    // synonym list is otherwise dominated by transliterations and abbreviations.
    const synonyms = (media.synonyms ?? [])
      .filter((s) => s && s.trim() && LATIN_ONLY_RE.test(s.trim()))
      .slice(0, 2);

    const out = Array.from(new Set([...primary, ...synonyms, ...fallback].map((s) => s.trim())));
    if (out.length > 0) titleCache.set(anilistId, out);
    return out.length > 0 ? out : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fuzzy-pick the best provider search hit for a set of target titles.
 *
 * Scores every candidate name against every target title (normalized) and
 * returns the highest-scoring candidate, or null when nothing clears
 * `threshold`. Comparing against the whole title set — not just one — is what
 * lets an English-only catalogue match a romaji-only query and vice versa.
 */
export function pickBestMangaCandidate<T>(
  titles: string[],
  candidates: T[],
  getNames: (candidate: T) => Array<string | null | undefined>,
  threshold = 0.6,
): { candidate: T; score: number } | null {
  const targets = titles.map((t) => normalizeTitle(t)).filter(Boolean);
  if (targets.length === 0 || candidates.length === 0) return null;

  let best: { candidate: T; score: number } | null = null;
  for (const candidate of candidates) {
    const names = getNames(candidate)
      .filter((n): n is string => Boolean(n && n.trim()))
      .map((n) => normalizeTitle(n));
    let score = 0;
    for (const name of names) {
      for (const target of targets) {
        score = Math.max(score, scoreMatch(target, name));
      }
    }
    if (!best || score > best.score) best = { candidate, score };
  }

  return best && best.score >= threshold ? best : null;
}
