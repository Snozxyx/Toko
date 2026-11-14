// Adapted from the independent HentaiDB extension. hentaidb.xyz data client — discovers & caches the client-side catalog
// (self.CAT in /cat-<hash>.js), decodes its compact rows, and extracts the
// per-episode window.EP payload from /watch pages. All media on hentaidb.xyz
// is public and header-free, so SourceResults carry no headers (no proxy).

const BASE = 'https://hentaidb.xyz';
export { BASE };
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CAT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const TYPES = ['OVA', 'Movie', 'TV Series', 'Web', 'Other'];
const STATUSES = ['Completed', 'Ongoing', 'Stalled'];

export interface Series {
  slug: string;
  title: string;
  posterPath: string;
  year: number;
  studio: string;
  episodeCount: number;
  durations: number[];
  type: string;
  status: string;
  censored: boolean | null; // true=censored, false=uncensored, null=unknown
  quality: number; // max pixel width, e.g. 1920, 3840
  subs: boolean;
  subLangs: number;
  dub: boolean;
  tagIdx: number[];
  tags: string[];
  pop: number; // 1 = most popular; 0 = unranked
  keywords: string;
}

export interface Catalog {
  fetchedAt: number;
  tags: string[];
  studios: string[];
  series: Series[];
  bySlug: Map<string, Series>;
  topTags: string[];
}

export async function getText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', Referer: BASE + '/' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export function abs(p: string): string {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return BASE + (p.startsWith('/') ? p : '/' + p);
}

// Poster/thumbnail URL. hentaidb serves resized images at /i/<w><path> for
// paths under /v/<n>/ or /cm/ (mirrors the site's own render.js helper).
export function imageUrl(p: string, w?: number): string | undefined {
  if (!p) return undefined;
  if (w && /^\/(?:v\/\d+|cm)\//.test(p)) return `${BASE}/i/${w}${p}`;
  return abs(p);
}

export function qualityLabel(q: number): string {
  if (!q) return '';
  if (q >= 2160) return '4K';
  if (q >= 1440) return '1440p';
  if (q >= 1080) return '1080p';
  if (q >= 720) return '720p';
  if (q >= 480) return '480p';
  return 'SD';
}

function cleanTitle(t: string): string {
  return String(t || '').replace(/^#\s*/, '').trim();
}
export { cleanTitle };

function decodeEntities(s: string): string {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .trim();
}
export { decodeEntities };

// Extract a balanced {...} object starting at the first '{' after `from`,
// respecting string literals and escapes.
export function sliceObject(s: string, from: number): string {
  const start = s.indexOf('{', from);
  if (start < 0) throw new Error('no object literal found');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced object literal');
}

interface RawRow {
  s: string; t: string; a?: string; y?: number; st?: number; e?: number;
  d?: number[]; ty?: number; sa?: number; c?: number; q?: number;
  u?: number; ul?: number; dub?: unknown; g?: number[]; p?: number; k?: string;
}

function decodeRow(o: RawRow, tags: string[], studios: string[]): Series {
  const g = Array.isArray(o.g) ? o.g : [];
  return {
    slug: o.s,
    title: cleanTitle(o.t),
    posterPath: o.a || '',
    year: o.y || 0,
    studio: o.st != null ? studios[o.st] || '' : '',
    episodeCount: o.e || 0,
    durations: Array.isArray(o.d) ? o.d : [],
    type: o.ty ? TYPES[o.ty - 1] || '' : '',
    status: o.sa ? STATUSES[o.sa - 1] || '' : '',
    censored: o.c === 1 ? true : o.c === 2 ? false : null,
    quality: o.q || 0,
    subs: o.u === 2,
    subLangs: o.ul || 0,
    dub: !!o.dub,
    tagIdx: g,
    tags: g.map((i) => tags[i]).filter(Boolean) as string[],
    pop: o.p || 0,
    keywords: o.k || '',
  };
}

let cache: Catalog | null = null;
let inflight: Promise<Catalog> | null = null;

async function discoverCatalogUrl(): Promise<string> {
  const html = await getText(BASE + '/');
  const m = html.match(/data-cat="([^"]+)"/);
  if (!m) throw new Error('catalog url (data-cat) not found on homepage');
  return abs(m[1]);
}

async function loadCatalog(): Promise<Catalog> {
  const catUrl = await discoverCatalogUrl();
  const js = await getText(catUrl);
  const raw = JSON.parse(sliceObject(js, js.indexOf('CAT')));
  const tags: string[] = Array.isArray(raw.tags) ? raw.tags : [];
  const studios: string[] = Array.isArray(raw.studios) ? raw.studios : [];
  const rows: RawRow[] = Array.isArray(raw.rows) ? raw.rows : [];
  const series = rows.map((r) => decodeRow(r, tags, studios)).filter((s) => s.slug);
  const bySlug = new Map(series.map((s) => [s.slug, s]));

  // Rank tags by usage for the home page's tag rows.
  const counts = new Map<number, number>();
  for (const s of series) for (const i of s.tagIdx) counts.set(i, (counts.get(i) || 0) + 1);
  const topTags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => tags[i])
    .filter(Boolean) as string[];

  return { fetchedAt: Date.now(), tags, studios, series, bySlug, topTags };
}

export async function getCatalog(force = false): Promise<Catalog> {
  if (!force && cache && Date.now() - cache.fetchedAt < CAT_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = loadCatalog()
    .then((c) => {
      cache = c;
      return c;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface CustomMediaCard {
  id: string;
  title: string;
  image?: string;
  subtitle?: string;
  badge?: string;
}

export interface SubtitleTrack {
  url: string;
  src: string;
  file: string;
  label: string;
  lang?: string;
  language?: string;
  kind: string;
}

export interface SourceResult {
  source: string;
  server?: string;
  url: string;
  quality: string;
  headers: Record<string, string>;
  subtitles: SubtitleTrack[];
  audioLanguage?: string;
  sourceType?: 'torrent' | 'hls' | 'mp4' | 'custom';
}

function card(s: Series): CustomMediaCard {
  const bits = [s.type, s.year ? String(s.year) : '', s.studio].filter(Boolean);
  const badge =
    qualityLabel(s.quality) === '4K'
      ? '4K'
      : s.censored === false
        ? 'Uncensored'
        : qualityLabel(s.quality) || undefined;
  return {
    id: s.slug,
    title: s.title,
    image: imageUrl(s.posterPath, 480),
    subtitle: bits.join(' · ') || undefined,
    badge,
  };
}

const byPopularity = (a: Series, b: Series) =>
  (a.pop || 1e9) - (b.pop || 1e9) || b.year - a.year;

export async function homeSections(): Promise<
  { title: string; items: CustomMediaCard[] }[]
> {
  const cat = await getCatalog();
  const ranked = cat.series.filter((s) => s.pop).sort(byPopularity);
  const pool = ranked.length ? ranked : cat.series;
  const sections: { title: string; items: CustomMediaCard[] }[] = [];

  const push = (title: string, list: Series[], n = 24) => {
    const items = list.slice(0, n).map(card);
    if (items.length) sections.push({ title, items });
  };

  push('Popular', pool, 30);
  push(
    'Recently Added',
    cat.series.slice().sort((a, b) => b.year - a.year || byPopularity(a, b)),
    30,
  );
  push('4K', pool.filter((s) => s.quality >= 2160), 30);
  push('Uncensored', pool.filter((s) => s.censored === false), 30);
  push('Movies', pool.filter((s) => s.type === 'Movie'), 24);

  for (const t of cat.topTags.slice(0, 10)) {
    push(t, pool.filter((s) => s.tags.includes(t)), 24);
  }
  return sections;
}

export interface SearchFilters {
  tags?: string[];
  type?: string;
  status?: string;
  quality?: string;
  censorship?: string;
  sort?: string;
}

const QUALITY_MIN: Record<string, number> = {
  '4K': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480,
};

// Narrow a series list by the user's chosen filter chips/dropdowns.
function applyFilters(list: Series[], f?: SearchFilters): Series[] {
  if (!f) return list;
  const tags = (f.tags || []).map((t) => t.toLowerCase());
  const minQ = f.quality ? QUALITY_MIN[f.quality] || 0 : 0;
  let out = list.filter((s) => {
    if (tags.length) {
      const have = s.tags.map((t) => t.toLowerCase());
      if (!tags.every((t) => have.includes(t))) return false;
    }
    if (f.type && s.type !== f.type) return false;
    if (f.status && s.status !== f.status) return false;
    if (minQ && s.quality < minQ) return false;
    if (f.censorship === 'Censored' && s.censored !== true) return false;
    if (f.censorship === 'Uncensored' && s.censored !== false) return false;
    return true;
  });
  if (f.sort === 'newest') {
    out = out.slice().sort((a, b) => b.year - a.year || byPopularity(a, b));
  } else if (f.sort === 'episodes') {
    out = out.slice().sort((a, b) => b.episodeCount - a.episodeCount || byPopularity(a, b));
  }
  return out;
}

// Declarative filter schema the app renders over the search surface. Tags are
// multi-select chips; each group is a single-select dropdown.
export function videoFilterSchema(cat: Catalog): {
  tags?: string[];
  groups?: { key: string; label: string; options: { value: string; label: string }[] }[];
} {
  const opt = (v: string) => ({ value: v, label: v });
  const quals = [...new Set(cat.series.map((s) => qualityLabel(s.quality)).filter(Boolean))]
    .sort((a, b) => (QUALITY_MIN[b] || 0) - (QUALITY_MIN[a] || 0));
  return {
    tags: cat.topTags.slice(0, 40),
    groups: [
      { key: 'sort', label: 'Sort', options: [
        { value: 'popular', label: 'Popular' },
        { value: 'newest', label: 'Newest' },
        { value: 'episodes', label: 'Most Episodes' },
      ] },
      { key: 'type', label: 'Type', options: TYPES.map(opt) },
      { key: 'status', label: 'Status', options: STATUSES.map(opt) },
      { key: 'quality', label: 'Quality', options: quals.map(opt) },
      { key: 'censorship', label: 'Censorship', options: ['Uncensored', 'Censored'].map(opt) },
    ],
  };
}

export async function searchSeries(
  query: string,
  page = 1,
  filters?: SearchFilters,
): Promise<{ results: CustomMediaCard[]; hasNextPage: boolean }> {
  const cat = await getCatalog();
  const q = String(query || '').trim().toLowerCase();
  let list: Series[];

  if (!q) {
    const ranked = cat.series.filter((s) => s.pop).sort(byPopularity);
    list = ranked.length ? ranked : cat.series;
  } else {
    const terms = q.split(/\s+/).filter(Boolean);
    const scored: { s: Series; score: number }[] = [];
    for (const s of cat.series) {
      const tl = s.title.toLowerCase();
      const kw = ' ' + s.keywords.toLowerCase();
      const studio = s.studio.toLowerCase();
      let ok = true;
      let score = 0;
      for (const t of terms) {
        if (tl === t) score += 100;
        else if (tl.startsWith(t)) score += 70;
        else if (tl.includes(' ' + t)) score += 50;
        else if (tl.includes(t)) score += 35;
        else if (kw.includes(' ' + t)) score += 25;
        else if (studio.includes(t)) score += 20;
        else if (s.tags.some((tag) => tag.toLowerCase().includes(t))) score += 15;
        else {
          ok = false;
          break;
        }
      }
      if (ok) scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score || byPopularity(a.s, b.s));
    list = scored.map((x) => x.s);
  }

  list = applyFilters(list, filters);

  const PAGE = 60;
  const start = (Math.max(1, page) - 1) * PAGE;
  const slice = list.slice(start, start + PAGE);
  return { results: slice.map(card), hasNextPage: start + PAGE < list.length };
}

async function fetchDescription(slug: string): Promise<string> {
  try {
    const html = await getText(`${BASE}/s/${encodeURIComponent(slug)}`);
    const m =
      html.match(/<meta property="og:description" content="([^"]*)"/i) ||
      html.match(/<meta name=["']?description["']? content="([^"]*)"/i);
    return m ? decodeEntities(m[1]) : '';
  } catch {
    return '';
  }
}

export interface InfoResult {
  id: string;
  title: string;
  image?: string;
  description?: string;
  meta?: Record<string, string>;
  entries: { id: string; label: string; number?: number }[];
}

export async function seriesInfo(id: string): Promise<InfoResult> {
  const cat = await getCatalog();
  const s = cat.bySlug.get(id);
  if (!s) {
    return { id, title: cleanTitle(id.replace(/[-~]/g, ' ')), entries: [] };
  }

  const meta: Record<string, string> = {};
  if (s.type) meta['Type'] = s.type;
  if (s.year) meta['Year'] = String(s.year);
  if (s.studio) meta['Studio'] = s.studio;
  if (s.status) meta['Status'] = s.status;
  meta['Episodes'] = String(s.episodeCount);
  if (s.quality) meta['Quality'] = qualityLabel(s.quality);
  if (s.censored != null) meta['Censorship'] = s.censored ? 'Censored' : 'Uncensored';
  if (s.subs) meta['Subtitles'] = s.subLangs > 1 ? `${s.subLangs} languages` : 'English';
  if (s.dub) meta['Dub'] = 'Yes';
  if (s.tags.length) meta['Tags'] = s.tags.join(', ');

  const count = Math.max(1, s.episodeCount || 1);
  const entries = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return { id: `${s.slug}~${n}`, label: `Episode ${n}`, number: n };
  });

  const description = await fetchDescription(s.slug);
  return {
    id: s.slug,
    title: s.title,
    image: imageUrl(s.posterPath),
    description,
    meta,
    entries,
  };
}

interface EpSrc {
  file: string;
  q?: string;
  r?: number;
  n?: number;
  off?: unknown;
}
interface EpTrack {
  file: string;
  label?: string;
  kind?: string;
}
interface EP {
  src?: EpSrc[];
  dub?: EpSrc[];
  tracks?: EpTrack[];
}

const LANGS: Record<string, string> = {
  english: 'en', spanish: 'es', portuguese: 'pt', french: 'fr', german: 'de',
  italian: 'it', russian: 'ru', arabic: 'ar', japanese: 'ja', chinese: 'zh',
  korean: 'ko', turkish: 'tr', indonesian: 'id', thai: 'th', vietnamese: 'vi',
};
function langOf(label?: string): string | undefined {
  if (!label) return undefined;
  const key = label.trim().toLowerCase();
  if (LANGS[key]) return LANGS[key];
  for (const [name, code] of Object.entries(LANGS)) {
    if (key.includes(name)) return code;
  }
  return undefined;
}

function rung(q?: string, r?: number): number {
  if (r) return r;
  const m = /(\d{3,4})/.exec(q || '');
  return m ? Number(m[1]) : 0;
}

// Resolve the episode watch-id. The app passes `id` (series slug) and
// `episodeId` (an entry id like "slug~1"); be tolerant of either carrying the
// full "slug~n" form.
export function resolveEpisodeId(id: string, episodeId?: string): string {
  const ep = String(episodeId || '').trim();
  if (ep.includes('~')) return ep;
  const base = String(id || '').trim();
  if (base.includes('~')) return base;
  if (base && ep) return `${base}~${ep}`;
  if (base) return `${base}~1`;
  return ep;
}

export async function episodeSources(watchId: string): Promise<SourceResult[]> {
  if (!watchId) return [];
  const html = await getText(`${BASE}/watch/${encodeURIComponent(watchId)}`);
  const idx = html.indexOf('window.EP');
  if (idx < 0) return [];
  let ep: EP;
  try {
    ep = JSON.parse(sliceObject(html, idx));
  } catch {
    return [];
  }

  const rawTracks: SubtitleTrack[] = (ep.tracks || [])
    .filter((t) => t && t.file && (t.kind === 'captions' || t.kind === 'subtitles'))
    .map((t) => {
      const u = abs(t.file);
      return {
        url: u,
        src: u,
        file: u,
        label: t.label || 'Subtitle',
        lang: langOf(t.label),
        language: t.label || undefined,
        kind: 'captions',
      };
    });
  // The watch page can list the same language several times (mirror files).
  // Keep one track per language (or per label when the language is unknown) so
  // the player shows a clean subtitle menu instead of 25 identical entries.
  const seenSub = new Set<string>();
  const subtitles: SubtitleTrack[] = rawTracks.filter((t) => {
    const key = (t.lang || t.label || '').toLowerCase();
    if (!key || seenSub.has(key)) return false;
    seenSub.add(key);
    return true;
  });

  const hasDub = Array.isArray(ep.dub) && ep.dub.length > 0;
  const toSource = (x: EpSrc, audio: 'sub' | 'dub'): SourceResult => {
    const isHls = /\.m3u8(\?|$)/i.test(x.file);
    // Group label (sub/dub + server): all quality rungs of one server share it.
    const group = [hasDub ? (audio === 'dub' ? 'Dub' : 'Sub') : '', `Server ${x.n ?? '?'}`]
      .filter(Boolean)
      .join(' · ');
    const label = [group, x.q || ''].filter(Boolean).join(' · ');
    return {
      source: label,
      server: group,
      url: abs(x.file),
      quality: x.q || qualityLabel(x.r || 0) || '',
      // The media is public, but giving the source headers forces the host to
      // route it (and its subtitle tracks) through the same-origin local proxy.
      // Header-free sources are served directly, which leaves cross-origin
      // WebVTT tracks unproxied — the renderer then can't load them (CORS) and
      // the player shows 0 subtitles. Proxying fixes that.
      headers: subtitles.length ? { Referer: BASE + '/' } : {},
      subtitles,
      audioLanguage: audio === 'dub' ? 'en' : 'ja',
      sourceType: isHls ? 'hls' : 'mp4',
    };
  };

  const sub = (ep.src || []).filter((x) => x && x.file && !x.off).map((x) => toSource(x, 'sub'));
  const dub = (ep.dub || []).filter((x) => x && x.file && !x.off).map((x) => toSource(x, 'dub'));
  const all = [...sub, ...dub];
  // Highest quality first so the player defaults to the best stream.
  all.sort((a, b) => rung(b.quality) - rung(a.quality));
  return all;
}

