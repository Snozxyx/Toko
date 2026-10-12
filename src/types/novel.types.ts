/**
 * Novel-related type definitions.
 *
 * Novels are text chapters (not image pages), so they get their own contract:
 * chapter listing is identical in shape to manga (number/title/volume/sources),
 * but reading returns ordered paragraphs instead of image URLs.
 *
 * Metadata (title, cover, synopsis, genres) always comes from AniList
 * (type MANGA, format NOVEL) + MangaBaka enrichment on the app side — never
 * from the scraper. Providers only supply chapter identity + chapter text.
 */

export interface NovelChapterSource {
  provider: string;
  /** Format: "<provider>:<providerChapterId>" (URL-safe, no spaces). */
  chapterKey: string;
  providerChapterId: string;
  language: string;
  translator: string | null;
  releaseDate: string | null;
}

export interface NovelChapterEntry {
  number: number;
  title: string | null;
  volume: string | null;
  sources: NovelChapterSource[];
}

export interface NovelParagraph {
  /** 0-based order within the chapter. */
  index: number;
  /** Plain-text paragraph (HTML stripped, entities decoded). */
  text: string;
}

export interface NovelContentEntry {
  title: string | null;
  number: number | null;
  /** Ordered chapter body. Empty array = provider has no text (fallback to next source). */
  paragraphs: NovelParagraph[];
  /** Provider that served this content. */
  provider: string;
}

export interface NovelChapterParams {
  /** Explicit diagnostics can wait for every provider; normal reading returns early. */
  fullScan?: boolean;
  /** Explicit provider match chosen by the user; skips fuzzy mapping. */
  provider?: string;
  seriesId?: string;
  anilistId?: number;
  malId?: number;
  title?: string;
  /**
   * Resolved AniList titles + synonyms, best-first. Populated once by the
   * bundle before provider fan-out so each provider fuzzy-searches against the
   * full set instead of re-querying AniList.
   */
  titles?: string[];
}
