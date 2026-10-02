/**
 * Adapter from the Nuvio provider shape to Toko's `StreamProvider`.
 *
 * The four upstream repos all implement the same contract —
 * `getStreams(tmdbId, type, season, episode)` returning loosely-typed stream
 * objects — while Toko providers implement `single(opts)` returning
 * `SourceResult[]` keyed on an AniList id. Rather than repeat that translation
 * in each of the ~68 ported providers, every port supplies only its
 * site-specific `extract` function and this factory supplies the rest:
 *
 *   AniList id ──▶ ani.zip ──▶ tmdbId + season + episode + localized titles
 *                                        │
 *                                        ▼
 *                                    extract(ctx)
 *                                        │
 *                                        ▼
 *                          normalize ──▶ SourceResult[]
 *
 * Consolidating it here means quality parsing, language normalization, dedup,
 * abort handling and the time budget behave identically across all of them, and
 * a fix to any of those lands everywhere at once.
 */

import type {
  StreamProvider,
  SourceOptions,
  SourceResult,
  SubtitleTrack,
  LanguageCapability,
} from '../../../types/index.js';
import { resolveTmdbTarget } from '../../../utils/mapping/anizip.js';

/**
 * A stream as the upstream providers emit it.
 *
 * Every field is optional except `url` because the repos disagree on which they
 * populate — some set `title`, others `name`; some set `quality`, others encode
 * it in the title. Normalization below tolerates all of it.
 */
export interface NuvioStream {
  url: string;
  title?: string;
  name?: string;
  quality?: string;
  /** Free-form: 'VF', 'VOSTFR', 'LAT', 'fr', 'Hindi', … */
  language?: string;
  provider?: string;
  headers?: Record<string, string>;
  /** Human-readable size, e.g. "1.4 GB". Informational only. */
  size?: string;
  /** 'hls' | 'mp4' | 'mkv' | 'dash' | … */
  type?: string;
  server?: string;
  subtitles?: Array<{
    url: string;
    label?: string;
    language?: string;
    lang?: string;
  }>;
}

/** Everything a ported scraper receives. */
export interface NuvioContext {
  /** TMDB id, or null when ani.zip has no mapping — fall back to title search. */
  tmdbId: string | null;
  /**
   * IMDb id (`tt…`) from ani.zip, or null when it has no IMDb mapping.
   *
   * Providers that key off IMDb (pelisgo, sololatino, xupalace, vegamovies,
   * 4khdhub, vaplayer, vidking) should read this first and only fall back to a
   * TMDB `/external_ids` call when it is null — Toko carries no TMDB api_key, so
   * that fallback is best-effort.
   */
  imdbId: string | null;
  type: 'movie' | 'tv';
  season?: number;
  episode?: number;
  /**
   * Episode counted from the start of the series rather than the cour.
   *
   * Sites that list a long show as one flat run — anime-ultime, animevost, most
   * fansub catalogues — only know this number. Undefined for movies and for
   * lookups ani.zip could not map.
   */
  absoluteEpisode?: number;
  /** The episode number Toko was asked for, before any mapping. */
  requestedEpisode?: number;
  /** Search titles, best-first, localized for the provider's language. */
  titles: string[];
  anilistId: number;
  /** True when season/episode are a real mapping rather than an assumption. */
  mapped: boolean;
  /** Aborted when the provider's time budget expires. Check it in every loop. */
  signal: AbortSignal;
  /** Caller's requested resolution, e.g. "1080p". Advisory. */
  resolution?: string;
  preferredLanguages?: string[];
}

export type NuvioExtractor = (ctx: NuvioContext) => Promise<NuvioStream[]>;

export interface NuvioProviderConfig {
  /** Registry name. Lowercase, hyphen-free where possible (see providerPriorityOf). */
  name: string;
  /** Origins this provider talks to, primary first — used by health checks. */
  sites: string[];
  /**
   * Language to prefer when picking localized titles from ani.zip. A French site
   * indexes French names, so 'fr' here materially improves the hit rate.
   */
  language?: string;
  /** Total budget for one lookup. Default 20s. */
  timeoutMs?: number;
  /** Site-specific scraping logic. */
  extract: NuvioExtractor;
  /** Set when the site carries films and `movie()` should be exposed. */
  supportsMovie?: boolean;
  /** Advertised language capabilities for the Watch page's tabs. */
  languages?: LanguageCapability[];
  /**
   * Default audio language code for streams that carry no language of their own.
   * Prevents a whole provider collapsing into the "und" bucket.
   */
  defaultAudioLanguage?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

// ── Quality ──────────────────────────────────────────────────────────────────

const QUALITY_TIERS = [2160, 1440, 1080, 720, 480, 360, 240];

/**
 * Parse a quality label into a canonical `<height>p` string.
 *
 * More tolerant than `normalizeQuality` in utils/scraping/quality.ts, which does
 * an exact map lookup and returns 'unknown' for everything else. The upstream
 * providers emit values like "1080p H.264", "FHD", "4K HDR" and "HD 720", all of
 * which would be discarded by an exact match — and a source labelled 'unknown'
 * sorts to the bottom of the Watch page's quality list.
 */
export function parseQuality(raw: string | undefined): string {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '720p';

  if (/\b(4k|uhd|2160)\b/.test(value)) return '2160p';
  if (/\b(1440|qhd)\b/.test(value)) return '1440p';
  if (/\b(1080|fhd|fullhd|full hd)\b/.test(value)) return '1080p';
  if (/\b(720|hd)\b/.test(value)) return '720p';
  if (/\b(480|sd)\b/.test(value)) return '480p';
  if (/\b360\b/.test(value)) return '360p';
  if (/\b240\b/.test(value)) return '240p';

  const digits = value.match(/(\d{3,4})\s*p?/);
  if (digits) {
    const height = Number(digits[1]);
    let closest = QUALITY_TIERS[0];
    let delta = Math.abs(height - closest);
    for (const tier of QUALITY_TIERS) {
      const d = Math.abs(height - tier);
      if (d < delta) {
        delta = d;
        closest = tier;
      }
    }
    return `${closest}p`;
  }

  return '720p';
}

function qualityRank(quality: string): number {
  const match = quality.match(/(\d{3,4})p/);
  return match ? Number(match[1]) : 0;
}

// ── Language ─────────────────────────────────────────────────────────────────

/**
 * Free-form language tag → BCP 47 code plus a display label.
 *
 * The tags are the ones the four repos actually emit, which are regional
 * shorthand rather than language codes: French sites use VF/VOSTFR (dubbed vs
 * Japanese-audio-with-French-subs), Latino sites use LAT/CAST (Latin American vs
 * Castilian Spanish), Hindi sites use DUAL/MULTI. Mapping VOSTFR to 'fr' would
 * be wrong — the *audio* is Japanese — and that distinction is what the Watch
 * page's language tabs are built on, so it is preserved here.
 */
const LANGUAGE_TABLE: Record<string, { code: string; label: string }> = {
  // French
  vf: { code: 'fr', label: 'French Dub' },
  vff: { code: 'fr', label: 'French Dub' },
  vfq: { code: 'fr', label: 'French Dub (Quebec)' },
  vfi: { code: 'fr', label: 'French Dub' },
  vfb: { code: 'fr', label: 'French Dub (Belgium)' },
  truefrench: { code: 'fr', label: 'French Dub' },
  french: { code: 'fr', label: 'French Dub' },
  fr: { code: 'fr', label: 'French' },
  fra: { code: 'fr', label: 'French' },
  // Japanese audio with French subtitles — audio is ja, not fr.
  vostfr: { code: 'ja', label: 'Japanese (French Sub)' },
  vostf: { code: 'ja', label: 'Japanese (French Sub)' },
  vost: { code: 'ja', label: 'Japanese (Subbed)' },
  vosta: { code: 'ja', label: 'Japanese (English Sub)' },
  vo: { code: 'ja', label: 'Original Audio' },
  voa: { code: 'en', label: 'English' },
  // Spanish / Latin American
  lat: { code: 'es-419', label: 'Latin American Spanish' },
  latino: { code: 'es-419', label: 'Latin American Spanish' },
  esp: { code: 'es', label: 'Spanish' },
  cast: { code: 'es', label: 'Castilian Spanish' },
  castellano: { code: 'es', label: 'Castilian Spanish' },
  es: { code: 'es', label: 'Spanish' },
  spanish: { code: 'es', label: 'Spanish' },
  subesp: { code: 'ja', label: 'Japanese (Spanish Sub)' },
  sublat: { code: 'ja', label: 'Japanese (Spanish Sub)' },
  // Portuguese
  dub: { code: 'pt-BR', label: 'Portuguese Dub' },
  leg: { code: 'ja', label: 'Japanese (Portuguese Sub)' },
  pt: { code: 'pt', label: 'Portuguese' },
  'pt-br': { code: 'pt-BR', label: 'Brazilian Portuguese' },
  // South Asian
  hindi: { code: 'hi', label: 'Hindi' },
  hin: { code: 'hi', label: 'Hindi' },
  hi: { code: 'hi', label: 'Hindi' },
  tamil: { code: 'ta', label: 'Tamil' },
  telugu: { code: 'te', label: 'Telugu' },
  bengali: { code: 'bn', label: 'Bengali' },
  bangla: { code: 'bn', label: 'Bengali' },
  malayalam: { code: 'ml', label: 'Malayalam' },
  kannada: { code: 'kn', label: 'Kannada' },
  marathi: { code: 'mr', label: 'Marathi' },
  punjabi: { code: 'pa', label: 'Punjabi' },
  urdu: { code: 'ur', label: 'Urdu' },
  // Other
  english: { code: 'en', label: 'English' },
  eng: { code: 'en', label: 'English' },
  en: { code: 'en', label: 'English' },
  japanese: { code: 'ja', label: 'Japanese' },
  jap: { code: 'ja', label: 'Japanese' },
  ja: { code: 'ja', label: 'Japanese' },
  german: { code: 'de', label: 'German' },
  ger: { code: 'de', label: 'German' },
  de: { code: 'de', label: 'German' },
  arabic: { code: 'ar', label: 'Arabic' },
  ar: { code: 'ar', label: 'Arabic' },
  russian: { code: 'ru', label: 'Russian' },
  ru: { code: 'ru', label: 'Russian' },
  italian: { code: 'it', label: 'Italian' },
  it: { code: 'it', label: 'Italian' },
  multi: { code: 'multi', label: 'Multi-Audio' },
  dual: { code: 'multi', label: 'Dual Audio' },
};

export interface NormalizedLanguage {
  code: string;
  label: string;
}

/**
 * Resolve a language tag, checking the whole string before scanning for tokens.
 *
 * Order matters: "VOSTFR" contains "fr", so a naive substring scan would
 * classify Japanese-audio streams as French. The exact lookup runs first, and
 * the token scan prefers the longest match for the same reason.
 */
export function normalizeStreamLanguage(
  raw: string | undefined,
  fallbackCode?: string
): NormalizedLanguage | null {
  const value = String(raw || '').trim();
  if (!value) {
    return fallbackCode
      ? { code: fallbackCode, label: LANGUAGE_TABLE[fallbackCode]?.label || fallbackCode.toUpperCase() }
      : null;
  }

  const key = value.toLowerCase().replace(/[[\]()]/g, '').trim();
  const exact = LANGUAGE_TABLE[key];
  if (exact) return { ...exact };

  const tokens = Object.keys(LANGUAGE_TABLE).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    // Word-boundary match so 'fr' cannot fire inside 'vostfr'.
    if (new RegExp(`(^|[^a-z])${token}([^a-z]|$)`, 'i').test(key)) {
      return { ...LANGUAGE_TABLE[token] };
    }
  }

  if (fallbackCode) {
    return {
      code: fallbackCode,
      label: LANGUAGE_TABLE[fallbackCode]?.label || fallbackCode.toUpperCase(),
    };
  }
  return null;
}

// ── Stream typing ────────────────────────────────────────────────────────────

function inferSourceType(
  url: string,
  declared: string | undefined
): 'hls' | 'mp4' | 'custom' {
  const hint = String(declared || '').toLowerCase();
  if (hint === 'hls' || hint === 'm3u8') return 'hls';
  if (hint === 'mp4' || hint === 'mkv' || hint === 'webm') return 'mp4';

  const value = String(url || '').toLowerCase();
  if (value.includes('.m3u8') || value.includes('/hls/') || value.includes('/hls2/')) {
    return 'hls';
  }
  if (/\.(mp4|m4v|mkv|webm)(\?|#|$)/.test(value)) return 'mp4';
  // DASH has no SourceResult type of its own; 'custom' keeps the player from
  // mistakenly treating an .mpd manifest as progressive MP4.
  if (value.includes('.mpd')) return 'custom';
  return 'custom';
}

/** Placeholder media that some sites serve instead of a 404. */
function isJunkUrl(url: string): boolean {
  const value = String(url || '').toLowerCase();
  if (!value || !/^https?:\/\//.test(value)) return true;
  return (
    value.includes('big_buck_bunny') ||
    value.includes('bigbuckbunny') ||
    value.includes('test-videos.co.uk') ||
    value.includes('sample-videos.com') ||
    value.includes('/troll/') ||
    value.includes('example.com') ||
    value.includes('localhost')
  );
}

function normalizeSubtitles(stream: NuvioStream): SubtitleTrack[] {
  const raw = stream.subtitles;
  if (!Array.isArray(raw)) return [];
  const out: SubtitleTrack[] = [];
  for (const entry of raw) {
    const url = String(entry?.url || '').trim();
    if (!url) continue;
    const language = String(entry?.language || entry?.lang || '').trim();
    out.push({
      url,
      label: String(entry?.label || language || 'Subtitle').trim(),
      language: language || 'und',
    });
  }
  return out;
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Convert raw upstream streams into `SourceResult[]`.
 *
 * Dedup is by URL *and* language: the same file legitimately appears twice when a
 * site offers one video with several audio tracks, and collapsing those would
 * silently drop a language the user might have selected.
 */
export function normalizeStreams(
  streams: NuvioStream[],
  config: NuvioProviderConfig
): SourceResult[] {
  const out: SourceResult[] = [];
  const seen = new Set<string>();

  for (const stream of streams) {
    const url = String(stream?.url || '').trim();
    if (!url || isJunkUrl(url)) continue;

    const label = stream.title || stream.name || '';
    // Quality is often only present inside the title ("Server 1 - 1080p"), so
    // fall back to parsing the label before defaulting.
    const quality = parseQuality(stream.quality || label);

    const language = normalizeStreamLanguage(
      stream.language || label,
      config.defaultAudioLanguage
    );

    const dedupeKey = `${url}|${language?.code || 'und'}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const headers = { ...(stream.headers || {}) };
    // Most embed hosts reject a request with no Referer. Default it to the
    // provider's own origin so ported scrapers do not each have to remember.
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'referer')) {
      const site = config.sites[0];
      if (site) headers.Referer = site.endsWith('/') ? site : `${site}/`;
    }

    const server =
      stream.server ||
      stream.name ||
      (label ? label.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim() : undefined);

    const result: SourceResult = {
      source: config.name,
      url,
      quality,
      headers,
      subtitles: normalizeSubtitles(stream),
      sourceType: inferSourceType(url, stream.type),
      providerName: config.name,
      providerKey: config.name,
    };

    if (server) result.server = server;
    if (language) {
      result.audioLanguage = language.code;
      result.language = language.label;
    }
    if (stream.size) result.fileSize = stream.size;

    out.push(result);
  }

  // Highest quality first — the Watch page presents sources in array order.
  return out.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a Toko `StreamProvider` from a TMDB-keyed extractor.
 *
 * The returned provider never throws and never exceeds its budget: the runner
 * fans out ~68 providers concurrently, so one site hanging must not stall the
 * batch. Timeouts surface as an empty array, which the runner already reports as
 * `empty` rather than `error`.
 */
export function createNuvioProvider(
  config: NuvioProviderConfig
): StreamProvider {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function run(
    opts: SourceOptions,
    kind: 'tv' | 'movie'
  ): Promise<SourceResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const target = await resolveTmdbTarget({
        anilistId: opts.anilistId,
        episode: kind === 'movie' ? undefined : opts.episode,
        titles: opts.titles || [],
        language: config.language,
      });

      if (controller.signal.aborted) return [];

      // No TMDB id and no title to search on: there is nothing to look up, so
      // fail fast rather than spend the budget on requests that cannot resolve.
      if (!target.tmdbId && target.titles.length === 0) return [];

      const ctx: NuvioContext = {
        tmdbId: target.tmdbId,
        imdbId: target.imdbId,
        type: kind === 'movie' ? 'movie' : target.type,
        season: target.season,
        episode: target.episode,
        absoluteEpisode: target.absoluteEpisode,
        requestedEpisode: kind === 'movie' ? undefined : opts.episode,
        titles: target.titles,
        anilistId: opts.anilistId,
        mapped: target.mapped,
        signal: controller.signal,
        resolution: opts.resolution,
        preferredLanguages: opts.preferredLanguages,
      };

      const streams = await config.extract(ctx);
      if (!Array.isArray(streams) || streams.length === 0) return [];

      return normalizeStreams(streams, config);
    } catch {
      // Includes the abort. Providers report emptiness, not failure.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  const provider: StreamProvider = {
    name: config.name,
    sites: config.sites,
    single: (opts) => run(opts, 'tv'),
  };

  if (config.supportsMovie) {
    provider.movie = (opts) => run(opts, 'movie');
  }
  if (config.languages && config.languages.length > 0) {
    const languages = config.languages;
    provider.getLanguages = async () => languages;
  }

  return provider;
}
