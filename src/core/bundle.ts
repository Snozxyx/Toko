/**
 * Toko Bundle Class
 * Main entry point for the Toko extension runtime
 * Provides all public methods invoked by the Tatakai runtime
 */

import { fetchResponse } from '../utils/http/fetch.js';
import { detectSourceType } from '../utils/scraping/quality.js';
import { withProviderTimeout } from '../utils/common/timeout.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../utils/manga/manga-title-resolver.js';
import { buildSearchQueries } from '../utils/scraping/title-normalizer.js';
import { pickBestNovelCandidate, buildNovelSearchQueries } from '../utils/novel-title-match.js';
import { setCloudflareBrowserRuntime } from '../utils/common/cf-bypass.js';
import { normalizeNovelParagraphs } from '../utils/novel-text.js';
import { clearNovelHttpCache } from '../providers/novel/novel-http.js';
import {
  runProviders,
  runProvidersProgressive,
  resolveProviderRunOptions,
} from './provider-runner.js';
import {
  annotateResults,
  mergeMangaChapters,
} from './result-processor.js';

import {
  STREAM_PROVIDERS,
  TORRENT_PROVIDERS,
  MANGA_PROVIDERS,
  NOVEL_PROVIDERS,
  LEAD_STREAM_PROVIDERS,
  providerPriorityOf,
} from '../providers/registry.js';

import type {
  SourceOptions,
  SourceResult,
  LanguageCapability,
  MangaChapterEntry,
  MangaChapterParams,
  MangaPageEntry,
  NovelChapterEntry,
  NovelChapterParams,
  NovelContentEntry,
  PreviewResult,
  WebsiteIndexResult,
  ProviderDiagnostic,
  ProviderChunk,
  DebugProviderResult,
} from '../types/index.js';

// Worker sandbox globals injected by extension-worker-pool.cjs
declare const TATAKAI_API_BASE_URL: string | undefined;

/**
 * Custom error for chapter not found scenarios
 */
class ChapterNotFoundError extends Error {
  constructor(chapterKey: string) {
    super(`Chapter not found: ${chapterKey}`);
    this.name = 'ChapterNotFoundError';
  }
}

/**
 * Stamp each result with the registry rank of the provider that produced it.
 *
 * This is the extension stating which server should play, in a form that
 * survives everything downstream: the host's LRU cache, the SSE stream and the
 * app's source list all keep insertion order, and insertion order here is
 * provider *completion* order. `providerPriority` is the only thing that still
 * says "nebula is first" after that trip.
 *
 * `result.source` is the provider's own name; `providerName` is only set by
 * providers that expose several servers, so prefer the former and fall back.
 */
function stampPriority(results: SourceResult[], providerName: string): SourceResult[] {
  const fallback = providerPriorityOf(providerName);
  return results.map(result => ({
    ...result,
    providerPriority: result.source
      ? providerPriorityOf(result.source)
      : fallback,
  }));
}

/**
 * Main Toko Bundle Class
 * Orchestrates provider execution and result aggregation
 */
export class TokoBundleClass {
  private novelRuns = new Map<string, { at: number; complete: boolean; results: NovelChapterEntry[]; diagnostics: ProviderDiagnostic[]; ready: Promise<DebugProviderResult<NovelChapterEntry>> }>();
  private blockedNovelProviders = new Map<string, {at:number;error:Error}>();
  configureBrowserRuntime(runtime: Parameters<typeof setCloudflareBrowserRuntime>[0]): void {
    setCloudflareBrowserRuntime(runtime);
  }
  /**
   * Validates bundle initialization
   * Ensures at least one provider is available
   */
  validate(): { valid: boolean; reason?: string } {
    const totalProviders =
      STREAM_PROVIDERS.length +
      TORRENT_PROVIDERS.length +
      MANGA_PROVIDERS.length +
      NOVEL_PROVIDERS.length;

    if (totalProviders === 0) {
      return { valid: false, reason: 'No providers initialised' };
    }

    return { valid: true };
  }

  // ── Single Episode Sources ──────────────────────────────────────────────

  /**
   * Returns direct-stream sources for a single episode
   * Torrent providers are never called
   */
  async single(opts: SourceOptions): Promise<SourceResult[]> {
    const results = await runProviders(
      STREAM_PROVIDERS,
      async p => stampPriority(await p.single(opts), p.name),
      undefined,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return annotateResults(results);
  }

  /**
   * Debug variant of single() with diagnostic information
   */
  async debugSingle(opts: SourceOptions): Promise<DebugProviderResult<SourceResult>> {
    const diagnostics: ProviderDiagnostic[] = [];
    const results = await runProviders(
      STREAM_PROVIDERS,
      async p => stampPriority(await p.single(opts), p.name),
      diagnostics,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return { results: annotateResults(results), diagnostics };
  }

  /**
   * Progressive variant - calls onChunk as each provider resolves
   * Used for streaming/SSE endpoints
   */
  async streamAll(
    opts: SourceOptions,
    onChunk: (chunk: ProviderChunk<SourceResult>) => void
  ): Promise<SourceResult[]> {
    const options = resolveProviderRunOptions(opts.providerOptions);
    return runProvidersProgressive(
      STREAM_PROVIDERS,
      async p => stampPriority(annotateResults(await p.single(opts)), p.name),
      onChunk,
      options,
      { lead: LEAD_STREAM_PROVIDERS, priorityOf: providerPriorityOf }
    );
  }

  // ── Batch & Torrent Sources ─────────────────────────────────────────────

  /**
   * Returns combined stream + torrent sources
   * Both provider sets run concurrently
   */
  async batch(opts: SourceOptions): Promise<SourceResult[]> {
    const options = resolveProviderRunOptions(opts.providerOptions);
    const [stream, torrent] = await Promise.all([
      runProviders(STREAM_PROVIDERS, async p => stampPriority(await p.single(opts), p.name), undefined, options),
      runProviders(TORRENT_PROVIDERS, async p => stampPriority(await p.batch(opts), p.name), undefined, options),
    ]);
    return annotateResults([...stream, ...torrent]);
  }

  /**
   * Debug variant of batch() with diagnostics
   */
  async debugBatch(opts: SourceOptions): Promise<DebugProviderResult<SourceResult>> {
    const diagnostics: ProviderDiagnostic[] = [];
    const options = resolveProviderRunOptions(opts.providerOptions);
    const [stream, torrent] = await Promise.all([
      runProviders(STREAM_PROVIDERS, async p => stampPriority(await p.single(opts), p.name), diagnostics, options),
      runProviders(TORRENT_PROVIDERS, async p => stampPriority(await p.batch(opts), p.name), diagnostics, options),
    ]);
    return { results: annotateResults([...stream, ...torrent]), diagnostics };
  }

  /**
   * Progressive variant of torrent batch
   */
  async torrentAll(
    opts: SourceOptions,
    onChunk: (chunk: ProviderChunk<SourceResult>) => void
  ): Promise<SourceResult[]> {
    const options = resolveProviderRunOptions(opts.providerOptions);
    return runProvidersProgressive(
      TORRENT_PROVIDERS,
      async p => stampPriority(annotateResults(await p.batch(opts)), p.name),
      onChunk,
      options,
      { priorityOf: providerPriorityOf }
    );
  }

  /**
   * Progressive variant streaming BOTH stream and torrent results
   */
  async sourcesAll(
    opts: SourceOptions,
    onChunk: (chunk: ProviderChunk<SourceResult>) => void
  ): Promise<SourceResult[]> {
    const options = resolveProviderRunOptions(opts.providerOptions);
    const [streamResults, torrentResults] = await Promise.all([
      runProvidersProgressive(
        STREAM_PROVIDERS,
        async p => stampPriority(annotateResults(await p.single(opts)), p.name),
        onChunk,
        options,
        // Nebula's sources reach the app before any other provider's, so the
        // watch page opens on it rather than on whichever site happened to be
        // quickest. Bounded: a slow or dead nebula just loses the head start.
        { lead: LEAD_STREAM_PROVIDERS, priorityOf: providerPriorityOf }
      ),
      runProvidersProgressive(
        TORRENT_PROVIDERS,
        async p => stampPriority(annotateResults(await p.batch(opts)), p.name),
        onChunk,
        options,
        { priorityOf: providerPriorityOf }
      ),
    ]);
    return [...streamResults, ...torrentResults];
  }

  // ── Per-provider introspection & execution ──────────────────────────────
  //
  // The aggregate calls above run every provider behind one request, which makes
  // a single misbehaving provider indistinguishable from a slow one. These two
  // methods are the debugging/scalability counterpart the host mounts as
  // `/providers` and `/providers/<name>`: one provider, one API call, one
  // diagnostic. Any extension implementing this pair gets the same endpoints —
  // nothing here is Toko-specific beyond the registry it reads.

  /**
   * Every provider this bundle can run, with the kind of call it answers.
   * `kind` tells the caller which entry point a provider uses: stream providers
   * resolve one episode (`single`), torrent providers query an indexer (`batch`).
   */
  listProviders(): Array<{ name: string; kind: 'stream' | 'torrent' | 'manga' | 'novel'; priority: number }> {
    return [
      ...STREAM_PROVIDERS.map(p => ({ name: p.name, kind: 'stream' as const, priority: providerPriorityOf(p.name) })),
      ...TORRENT_PROVIDERS.map(p => ({ name: p.name, kind: 'torrent' as const, priority: providerPriorityOf(p.name) })),
      ...MANGA_PROVIDERS.map((p, i) => ({ name: p.name, kind: 'manga' as const, priority: i })),
      ...NOVEL_PROVIDERS.map((p, i) => ({ name: p.name, kind: 'novel' as const, priority: i })),
    ];
  }

  /**
   * Runs exactly one provider by name, with the same timeout/retry policy the
   * aggregate calls use, and returns its diagnostic alongside the results.
   * Manga providers are rejected — they answer a different contract.
   *
   * @throws Error when `providerName` matches no stream/torrent provider.
   */
  async runProvider(
    providerName: string,
    opts: SourceOptions
  ): Promise<ProviderChunk<SourceResult> & { kind: 'stream' | 'torrent' }> {
    const wanted = String(providerName || '').trim().toLowerCase();
    if (!wanted) throw new Error('provider name is required');

    const options = resolveProviderRunOptions(opts.providerOptions);
    const stream = STREAM_PROVIDERS.find(p => p.name.toLowerCase() === wanted);
    const torrent = stream ? undefined : TORRENT_PROVIDERS.find(p => p.name.toLowerCase() === wanted);

    if (!stream && !torrent) {
      throw new Error(`unknown provider: ${providerName}`);
    }

    let chunk: ProviderChunk<SourceResult> | undefined;
    const capture = (c: ProviderChunk<SourceResult>) => { chunk = c; };

    if (stream) {
      await runProvidersProgressive(
        [stream],
        async p => stampPriority(annotateResults(await p.single(opts)), p.name),
        capture,
        options,
        { priorityOf: providerPriorityOf }
      );
    } else {
      await runProvidersProgressive(
        [torrent!],
        async p => stampPriority(annotateResults(await p.batch(opts)), p.name),
        capture,
        options,
        { priorityOf: providerPriorityOf }
      );
    }

    const name = (stream || torrent)!.name;
    return {
      provider: name,
      kind: stream ? 'stream' : 'torrent',
      results: chunk?.results ?? [],
      diagnostic: chunk?.diagnostic ?? {
        provider: name,
        status: 'empty',
        durationMs: 0,
        resultCount: 0,
        attempts: 0,
      },
    };
  }

  // ── Movie Sources ───────────────────────────────────────────────────────

  /**
   * Returns direct-stream sources for movies (no episode constraint)
   * Torrent providers are never called
   */
  async movie(opts: SourceOptions): Promise<SourceResult[]> {
    const results = await runProviders(
      STREAM_PROVIDERS,
      p => (p.movie ? p.movie(opts) : p.single(opts)),
      undefined,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return annotateResults(results);
  }

  // ── Language Capabilities ───────────────────────────────────────────────

  /**
   * Aggregates language capabilities from all stream providers
   */
  async getLanguages(opts: SourceOptions): Promise<LanguageCapability[]> {
    const results = await runProviders(
      STREAM_PROVIDERS,
      async p => {
        if (p.getLanguages) return p.getLanguages(opts);
        return [];
      },
      undefined,
      resolveProviderRunOptions(opts.providerOptions)
    );
    return results as LanguageCapability[];
  }

  // ── Manga Support ───────────────────────────────────────────────────────

  /**
   * Resolve AniList titles once, up front, so the whole provider fan-out shares
   * one GraphQL round trip instead of each fuzzy-matching provider re-querying
   * AniList. MangaDex maps deterministically and ignores `titles`, but AllManga
   * and Mangaball rely on it. No-op when the caller already supplied titles.
   */
  private async enrichMangaParams(params: MangaChapterParams): Promise<MangaChapterParams> {
    if (params.titles && params.titles.length > 0) return params;
    try {
      const titles = await withProviderTimeout(resolveMangaTitles(params), 1500);
      return titles.length > 0 ? { ...params, titles } : params.title ? { ...params, titles: [params.title] } : params;
    } catch {
      return params.title ? { ...params, titles: [params.title] } : params;
    }
  }

  /**
   * Returns manga chapters merged by chapter number
   * Multiple providers returning the same chapter number are merged
   */
  async getMangaChapters(params: MangaChapterParams): Promise<MangaChapterEntry[]> {
    const enriched = await this.enrichMangaParams(params);
    const deadline = Date.now() + 8000;
    const all = await runProviders(
      MANGA_PROVIDERS,
      p => withProviderTimeout(p.getChapters(enriched), Math.max(1, deadline - Date.now())), undefined,
      resolveProviderRunOptions({ timeoutMs: 8000, maxRetries: 0, maxConcurrency: 6 })
    ) as MangaChapterEntry[];
    return mergeMangaChapters(all);
  }

  /**
   * Debug variant of getMangaChapters() with diagnostics
   */
  async debugMangaChapters(
    params: MangaChapterParams
  ): Promise<DebugProviderResult<MangaChapterEntry>> {
    const enriched = await this.enrichMangaParams(params);
    const diagnostics: ProviderDiagnostic[] = [];
    const deadline = Date.now() + 8000;
    const all = await runProviders(
      MANGA_PROVIDERS,
      p => withProviderTimeout(p.getChapters(enriched), Math.max(1, deadline - Date.now())),
      diagnostics,
      resolveProviderRunOptions({ timeoutMs: 8000, maxRetries: 0, maxConcurrency: 6 })
    ) as MangaChapterEntry[];
    return { results: mergeMangaChapters(all), diagnostics };
  }

  /**
   * Returns pages for a specific chapter from named provider
   * Parses chapterKey as "<provider>:<providerChapterId>"
   */
  async getMangaPages(params: {
    chapterKey: string;
    provider?: string;
    providerChapterId?: string;
    anilistId?: number;
  }): Promise<MangaPageEntry[]> {
    const { chapterKey } = params;

    // Derive provider name from explicit param or chapterKey prefix
    let providerName = params.provider;
    if (!providerName) {
      const colonIdx = chapterKey.indexOf(':');
      providerName = colonIdx >= 0 ? chapterKey.slice(0, colonIdx) : chapterKey;
    }

    const provider = MANGA_PROVIDERS.find(p => p.name === providerName);
    if (!provider) throw new ChapterNotFoundError(chapterKey);

    const pages = await provider.getPages(chapterKey);
    if (pages.length === 0) throw new ChapterNotFoundError(chapterKey);

    return pages;
  }

  // ── Novel Support ───────────────────────────────────────────────────────

  private async enrichNovelParams(params: NovelChapterParams): Promise<NovelChapterParams> {
    if (params.seriesId && params.provider) return params;
    if (params.titles && params.titles.length > 0) return params;
    try {
      const titles = await withProviderTimeout(resolveMangaTitles(params), 1500);
      return titles.length > 0 ? { ...params, titles } : params.title ? { ...params, titles: [params.title] } : params;
    } catch {
      return params.title ? { ...params, titles: [params.title] } : params;
    }
  }

  private async searchThenScrapeNovel(provider: typeof NOVEL_PROVIDERS[number], params: NovelChapterParams, deadline?: number): Promise<NovelChapterEntry[]> {
    const blocked = this.blockedNovelProviders.get(provider.name);
    if (!params.provider && !params.fullScan && blocked && Date.now()-blocked.at < 60000) throw blocked.error;
    if (params.seriesId || !provider.search) return provider.getChapters(params);
    const titles = params.titles?.length ? params.titles : params.title ? [params.title] : [];
    // English + romaji cover these English catalogs. Diagnostics can inspect
    // all aliases; ordinary loading need not query German/Vietnamese synonyms.
    const queries = buildNovelSearchQueries(titles).slice(0, params.fullScan ? 4 : 2);
    const candidates: Array<{ id: string; title: string }> = [];
    let lastError: unknown;
    let answered = false;
    for (const query of queries) {
      if (deadline && Date.now() >= deadline) throw new Error('Novel discovery budget exhausted');
      try {
        candidates.push(...await provider.search(query));
        answered = true;
      } catch (error) {
        lastError = error;
        if (/HTTP (?:403|429|502|503)|access blocked/i.test(String((error as Error)?.message))) {
          if (/HTTP 403|access blocked/i.test(String((error as Error)?.message))) this.blockedNovelProviders.set(provider.name,{at:Date.now(),error:error as Error});
          throw error;
        }
        continue;
      }
      const match = pickBestNovelCandidate(titles, candidates);
      if (deadline && Date.now() >= deadline) throw new Error('Novel discovery budget exhausted');
      if (match?.score === 1) return provider.getChapters({ ...params, provider: provider.name, seriesId: match.candidate.id });
    }
    const match = pickBestNovelCandidate(titles, candidates);
    if (!answered && lastError) throw lastError;
    return match ? provider.getChapters({ ...params, provider: provider.name, seriesId: match.candidate.id }) : [];
  }

  /**
   * Returns novel chapters merged by chapter number.
   * Multiple providers returning the same chapter number are merged.
   */
  async getNovelChapters(params: NovelChapterParams): Promise<NovelChapterEntry[]> {
    // Hosts may destroy the invocation worker when this method returns. Wait
    // for the bounded scan here so later translators are not silently discarded.
    const enriched = await this.enrichNovelParams(params);
    const deadline = Date.now() + 8000;
    const all = await runProviders(
      NOVEL_PROVIDERS.filter(p => !params.provider || p.name === params.provider),
      p => withProviderTimeout(this.searchThenScrapeNovel(p, enriched, deadline), Math.max(1, deadline - Date.now())),
      undefined, resolveProviderRunOptions({ timeoutMs: 8000, maxRetries: 0, maxConcurrency: 4 })
    ) as NovelChapterEntry[];
    return mergeMangaChapters(all as any) as NovelChapterEntry[];
  }

  /**
   * Debug variant of getNovelChapters() with diagnostics.
   */
  async debugNovelChapters(
    params: NovelChapterParams
  ): Promise<DebugProviderResult<NovelChapterEntry>> {
    if (params.fullScan) clearNovelHttpCache();
    const enriched = await this.enrichNovelParams(params);
    if (!params.fullScan && !params.provider) {
      const key = JSON.stringify([enriched.anilistId || 0,enriched.malId || 0,enriched.titles?.[0] || enriched.title || '']);
      const hit = this.novelRuns.get(key);
      if (hit && Date.now() - hit.at < (hit.results.length ? 5 * 60000 : 30000)) {
        return hit.results.length ? { results: [...hit.results], diagnostics: [...hit.diagnostics], complete: hit.complete } : hit.ready;
      }
      let finish!: (result: DebugProviderResult<NovelChapterEntry>) => void;
      const record = { at: Date.now(), complete: false, results: [] as NovelChapterEntry[], diagnostics: [] as ProviderDiagnostic[], ready: new Promise<DebugProviderResult<NovelChapterEntry>>(resolve => { finish = resolve; }) };
      this.novelRuns.set(key, record);
      if (this.novelRuns.size > 30) this.novelRuns.delete(this.novelRuns.keys().next().value!);
      // Start public catalogs before bot-walled sites. On mobile, a solver
      // otherwise occupied all native request slots ahead of readable sources.
      const publicNames = ['syosetu','wuxiaworld','lightnovelto','novelbuddy','novgo','novelcool','novelfire','readnovelfull','relibrary','woopread','divinedaolibrary'];
      const providers = NOVEL_PROVIDERS.filter(p => !(process as any).browser || publicNames.includes(p.name)).sort((a,b) => {
        const rank=(name:string)=>{const index=publicNames.indexOf(name);return index<0?publicNames.length:index};
        return rank(a.name)-rank(b.name);
      });
      const deadline = Date.now() + 8000;
      const options = resolveProviderRunOptions({ timeoutMs: 8000, maxRetries: 0, maxConcurrency: 4 });
      void runProvidersProgressive(providers, p => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return Promise.reject(new Error('Novel discovery budget exhausted'));
        return withProviderTimeout(this.searchThenScrapeNovel(p, enriched, deadline), remaining);
      }, chunk => {
        record.diagnostics.push(chunk.diagnostic);
        if (chunk.results.length) {
          record.results = mergeMangaChapters([...record.results, ...chunk.results] as any) as any;
          finish({ results: [...record.results], diagnostics: [...record.diagnostics], complete: false });
        }
      }, options).then(() => { record.complete = true; finish({ results: [...record.results], diagnostics: [...record.diagnostics], complete: true }); })
        .catch(() => { record.complete = true; finish({ results: [...record.results], diagnostics: [...record.diagnostics], complete: true }); });
      return record.ready;
    }
    const diagnostics: ProviderDiagnostic[] = [];
    const all = await runProviders(
      NOVEL_PROVIDERS.filter(p => !params.provider || p.name === params.provider),
      p => this.searchThenScrapeNovel(p, enriched),
      diagnostics,
      { timeoutMs: (process as any).browser ? 60000 : 30000, maxRetries: 0, maxConcurrency: 10, retryDelayMs: 250 }
    ) as NovelChapterEntry[];
    return { results: mergeMangaChapters(all as any) as any, diagnostics, complete: true };
  }

  async getNovelSearch(params: { query: string; provider?: string }) {
    const query = String(params.query || '').trim().slice(0, 200);
    if (!query) return { results: [], providerStatus: [] };
    const rows = await Promise.all(NOVEL_PROVIDERS.filter(p => !params.provider || p.name === params.provider).map(async p => {
      try {
        const matches = await withProviderTimeout(p.search ? p.search(query) : Promise.resolve([]), (process as any).browser ? 60000 : 25000);
        return { results: matches.slice(0, 20).map(match => ({ ...match, provider: p.name })), status: { provider: p.name, status: matches.length ? 'ok' : 'empty', resultCount: matches.length } };
      } catch (error) { return { results: [], status: { provider: p.name, status: 'error', resultCount: 0, error: (error as Error).message } }; }
    }));
    return { results: rows.flatMap(row => row.results), providerStatus: rows.map(row => row.status) };
  }

  /**
   * Returns text content for a specific novel chapter from the named provider.
   * Parses chapterKey as "<provider>:<providerChapterId>".
   */
  async getNovelContent(params: {
    chapterKey: string;
    provider?: string;
    providerChapterId?: string;
    anilistId?: number;
  }): Promise<NovelContentEntry> {
    const { chapterKey } = params;
    let providerName = params.provider;
    if (!providerName) {
      const colonIdx = chapterKey.indexOf(':');
      providerName = colonIdx >= 0 ? chapterKey.slice(0, colonIdx) : chapterKey;
    }
    const provider = NOVEL_PROVIDERS.find(p => p.name === providerName);
    if (!provider) throw new ChapterNotFoundError(chapterKey);
    const content = await provider.getContent(chapterKey);
    if (!content) throw new ChapterNotFoundError(chapterKey);
    const paragraphs = normalizeNovelParagraphs(content.paragraphs);
    if (!paragraphs.length) throw new ChapterNotFoundError(chapterKey);
    return { ...content, paragraphs };
  }

  // ── Preview & Indexing ──────────────────────────────────────────────────

  /**
   * Returns preview stream source for hover/detail video previews
   * Never throws - returns null result on failure
   */
  async getPreviewSource(params: {
    anilistId: number;
    titles: string[];
    episode?: number;
  }): Promise<PreviewResult> {
    const NULL_RESULT: PreviewResult = {
      provider: null,
      streamUrl: null,
      isHls: false,
      previewTimestampSec: 0,
    };

    try {
      const opts: SourceOptions = {
        anilistId: params.anilistId,
        titles: params.titles,
        episode: params.episode,
        resolution: '1080p',
      };

      const results = await runProviders(
        STREAM_PROVIDERS,
        p => p.single(opts)
      ) as SourceResult[];

      const first = results.find(r => r.url && r.sourceType !== 'torrent');
      if (!first) return NULL_RESULT;

      return {
        provider: first.source,
        streamUrl: first.url,
        isHls: detectSourceType(first.url) === 'hls',
        previewTimestampSec: 0,
      };
    } catch {
      return NULL_RESULT;
    }
  }

  /**
   * Returns episode count and list from website-first indexing
   * Delegates to TatakaiAPI when available, otherwise tries direct scraping
   */
  async getWebsiteEpisodeIndex(params: {
    anilistId: number;
    tatakaiId?: string;
    titles: string[];
  }): Promise<WebsiteIndexResult> {
    const NULL_RESULT: WebsiteIndexResult = {
      provider: null,
      episodeCount: 0,
      episodes: [],
    };

    try {
      // Try TatakaiAPI first if available
      if (typeof TATAKAI_API_BASE_URL !== 'undefined' && TATAKAI_API_BASE_URL) {
        const url = new URL('/toko/index/episodes', TATAKAI_API_BASE_URL);
        url.searchParams.set('anilistId', String(params.anilistId));
        if (params.tatakaiId) {
          url.searchParams.set('tatakaiId', params.tatakaiId);
        }
        params.titles.forEach(t => url.searchParams.append('titles[]', t));

        try {
          const res = await fetchResponse(url.toString());
          if (res.ok) {
            const data = await res.json() as WebsiteIndexResult;
            if (data.provider && data.episodeCount > 0) return data;
          }
        } catch {
          // Fall through to direct provider attempt
        }
      }

      // Fallback: try sample episode to confirm availability
      const opts: SourceOptions = {
        anilistId: params.anilistId,
        titles: params.titles,
        episode: 1,
        resolution: '1080p',
      };

      for (const p of STREAM_PROVIDERS.slice(0, 3)) {
        try {
          const results = await withProviderTimeout(p.single(opts), 15_000);
          if (results.length > 0) {
            return {
              provider: p.name,
              episodeCount: 1,
              episodes: [{ number: 1 }],
            };
          }
        } catch {
          continue;
        }
      }

      return NULL_RESULT;
    } catch {
      return NULL_RESULT;
    }
  }
}
