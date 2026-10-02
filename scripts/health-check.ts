/**
 * Live provider health check.
 *
 * For each stream/torrent/manga provider: probe its declared origin for
 * reachability, then run its real resolution path against a popular fixture and
 * classify the outcome. Not bundled — a diagnostic tool run with tsx.
 *
 *   npx tsx scripts/health-check.ts [stream|torrent|manga|all] [filter]
 */
import { STREAM_PROVIDERS, TORRENT_PROVIDERS, MANGA_PROVIDERS } from '../src/providers/registry.js';
import type { StreamProvider, TorrentProvider, MangaProvider } from '../src/types/index.js';
import type { SourceOptions, MangaChapterParams } from '../src/types/index.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const CHALLENGE = [
  'just a moment', 'cf_chl_opt', '__cf_chl', 'challenge-platform',
  'cf-browser-verification', 'checking your browser', 'enable javascript and cookies',
  'attention required', 'ddos-guard', 'turnstile',
];

async function probe(site: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(site, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = (await res.text().catch(() => '')).slice(0, 6000).toLowerCase();
    const cf = CHALLENGE.some((m) => body.includes(m));
    if (cf) return `CF-WALL(${res.status})`;
    if (res.ok) return `up(${res.status})`;
    return `http(${res.status})`;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/abort/i.test(msg)) return 'DOWN(timeout)';
    return `DOWN(${msg.slice(0, 40)})`;
  } finally {
    clearTimeout(t);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Solo Leveling — extremely widely carried (JP/EN/FR/ES-LA/HI dubs), on TMDB.
const ANIME: SourceOptions = {
  anilistId: 151807,
  titles: [
    'Solo Leveling', 'Ore dake Level Up na Ken', 'I Alone Level-Up',
    'Na Honjaman Lebel-eop', '나 혼자만 레벨업',
  ],
  episode: 1,
  resolution: '1080p',
};

// One Piece manga — universally carried, maps on AniList/MAL id across providers.
const MANGA: MangaChapterParams = {
  anilistId: 30013,
  malId: 13,
  title: 'One Piece',
  titles: ['One Piece', 'ワンピース'],
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms)),
  ]);

type Verdict = { name: string; site: string; reach: string; fn: string; detail: string };

async function testStream(p: StreamProvider): Promise<Verdict> {
  const site = p.sites?.[0] || '';
  const reach = site ? await probe(site) : 'no-site';
  let fn = 'error', detail = '';
  try {
    const r = await withTimeout(p.single(ANIME), 25_000);
    if (r.length > 0) { fn = 'OK'; detail = `${r.length} src, q=${r[0].quality}, ${r[0].sourceType}`; }
    else { fn = 'empty'; }
  } catch (e: any) { fn = 'error'; detail = String(e?.message || e).slice(0, 80); }
  return { name: p.name, site, reach, fn, detail };
}

async function testTorrent(p: TorrentProvider): Promise<Verdict> {
  const site = p.sites?.[0] || '';
  const reach = site ? await probe(site) : 'no-site';
  let fn = 'error', detail = '';
  try {
    const r = await withTimeout(p.batch(ANIME), 25_000);
    if (r.length > 0) { fn = 'OK'; detail = `${r.length} torrents, top="${(r[0].torrentTitle || '').slice(0, 40)}" s=${r[0].seeders}`; }
    else { fn = 'empty'; }
  } catch (e: any) { fn = 'error'; detail = String(e?.message || e).slice(0, 80); }
  return { name: p.name, site, reach, fn, detail };
}

async function testManga(p: MangaProvider): Promise<Verdict> {
  const site = p.sites?.[0] || '';
  const reach = site ? await probe(site) : 'no-site';
  let fn = 'error', detail = '';
  try {
    const chapters = await withTimeout(p.getChapters(MANGA), 30_000);
    if (chapters.length === 0) { fn = 'empty'; detail = 'no chapters'; return { name: p.name, site, reach, fn, detail }; }
    // Pull pages for the first chapter sourced from THIS provider.
    const src = chapters.flatMap((c) => c.sources).find((s) => s.provider === p.name);
    if (!src) { fn = 'chapters-only'; detail = `${chapters.length} ch, none from this provider`; return { name: p.name, site, reach, fn, detail }; }
    const pages = await withTimeout(p.getPages(src.chapterKey), 30_000);
    if (pages.length > 0) { fn = 'OK'; detail = `${chapters.length} ch, ${pages.length} pages ch#${src.chapterKey}`; }
    else { fn = 'no-pages'; detail = `${chapters.length} ch but 0 pages`; }
  } catch (e: any) { fn = 'error'; detail = String(e?.message || e).slice(0, 80); }
  return { name: p.name, site, reach, fn, detail };
}

async function runPool<T, R>(items: T[], fn: (t: T) => Promise<R>, conc = 8): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

function table(title: string, rows: Verdict[]) {
  console.log(`\n=== ${title} (${rows.length}) ===`);
  for (const r of rows) {
    const flag = r.fn === 'OK' ? '✅' : r.fn === 'empty' || r.fn === 'chapters-only' ? '⚪' : '❌';
    console.log(`${flag} ${r.name.padEnd(22)} reach=${r.reach.padEnd(22)} fn=${r.fn.padEnd(14)} ${r.detail}`);
  }
}

async function main() {
  const which = (process.argv[2] || 'all').toLowerCase();
  const filter = (process.argv[3] || '').toLowerCase();
  const match = (n: string) => !filter || n.toLowerCase().includes(filter);

  if (which === 'stream' || which === 'all') {
    const rows = await runPool(STREAM_PROVIDERS.filter((p) => match(p.name)), testStream);
    table('STREAM', rows);
  }
  if (which === 'torrent' || which === 'all') {
    const rows = await runPool(TORRENT_PROVIDERS.filter((p) => match(p.name)), testTorrent);
    table('TORRENT', rows);
  }
  if (which === 'manga' || which === 'all') {
    const rows = await runPool(MANGA_PROVIDERS.filter((p) => match(p.name)), testManga, 6);
    table('MANGA', rows);
  }
  // Keep CF browser from holding the process open.
  setTimeout(() => process.exit(0), 500);
}

main();
