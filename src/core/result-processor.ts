/**
 * Result Processor
 * Transforms and enriches provider results
 */

import { inferTorrentFileFormat } from '../utils/torrent/matcher.js';
import { buildStreamRefererCandidates } from '../utils/http/referer-candidates.js';
import type { SourceResult, MangaChapterEntry } from '../types/index.js';

/**
 * Ensures every torrent result has proper magnet and file format fields
 */
export function annotateTorrentResults(results: SourceResult[]): SourceResult[] {
  return results.map((result) => {
    if (result.sourceType !== 'torrent') return result;

    const magnetLink = result.magnetLink ??
      (result.url.startsWith('magnet:') ? result.url : undefined);

    return {
      ...result,
      magnetLink,
      fileFormat: result.fileFormat ??
        inferTorrentFileFormat(result.torrentTitle, magnetLink, result.url),
    };
  });
}

/**
 * Stamps direct-stream results with an ordered `refererCandidates` list so the
 * (content-agnostic) app proxy knows which `Referer` values to try. Torrent
 * results are left untouched. The provider's own `headers.Referer` stays the
 * primary; the candidate list adds known-good alternates for that CDN family.
 */
export function annotateStreamReferers(results: SourceResult[]): SourceResult[] {
  return results.map((result) => {
    if (result.sourceType === 'torrent') return result;
    if (!result.url || result.url.startsWith('magnet:')) return result;

    const primaryReferer = result.headers?.Referer ?? result.headers?.referer;
    const candidates = buildStreamRefererCandidates(result.url, primaryReferer);
    if (candidates.length === 0) return result;

    return {
      ...result,
      // Keep any candidates a provider already set; otherwise use the computed list.
      refererCandidates: result.refererCandidates?.length
        ? result.refererCandidates
        : candidates,
    };
  });
}

/**
 * Full post-processing for a batch of provider results: torrent fields +
 * stream referer candidates. Both passes are no-ops for the other source type,
 * so this is safe to apply to any mixed result set.
 */
export function annotateResults(results: SourceResult[]): SourceResult[] {
  return annotateStreamReferers(annotateTorrentResults(results));
}

/**
 * Merges manga chapters by chapter number
 * Combines multiple sources for the same chapter into a single entry
 */
export function mergeMangaChapters(all: MangaChapterEntry[]): MangaChapterEntry[] {
  const map = new Map<number, MangaChapterEntry>();
  
  for (const ch of all) {
    if (map.has(ch.number)) {
      // Merge sources for existing chapter
      map.get(ch.number)!.sources.push(...ch.sources);
    } else {
      // Add new chapter entry
      map.set(ch.number, { ...ch, sources: [...ch.sources] });
    }
  }
  
  // Sort by chapter number ascending
  return Array.from(map.values()).sort((a, b) => a.number - b.number);
}
