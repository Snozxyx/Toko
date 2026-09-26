/**
 * Central provider registry for the Toko extension.
 * Import provider lists from here to keep index.ts focused on runtime logic.
 */
import type { StreamProvider, TorrentProvider, MangaProvider } from '../types/index.js';

// ── Stream providers ──────────────────────────────────────────────────────────
// Order is priority order. It is the extension — not the app — that decides
// which server the watch page opens on: every result is stamped with
// `providerPriority` derived from its index below (see `providerPriorityOf`),
// and the progressive runner holds non-lead chunks back briefly so the lead
// provider's sources are the first the UI ever sees (see LEAD_STREAM_PROVIDERS).
//
// Keep `nebula` first — it resolves straight from an AniList id with no title
// search, so it is both the fastest and the most reliable first frame.
// Providers removed 2026-08 after a live health check:
//   - `senshi` — senshi.live answers HTTP 500 on every route (search, episodes,
//     episode-embeds); the backend is down.
//   - `mkissa` — mkissa.to gates every non-browser request behind a reCAPTCHA
//     "Security Check" wall, so the scraper could never return a result.
//   - `acgrip` — acg.rip's RSS search endpoint returns an empty body for every
//     term (including none) and the site itself announces its tracker is no
//     longer valid, so neither discovery nor downloading can work.
import nebula from './stream/justanime.js';
import animepahe from './stream/animepahe.js';
import animeya from './stream/animeya.js';
import toonstream from './stream/toonstream.js';
import animelok from './stream/animelok.js';
import watchanimeworld from './stream/watchanimeworld.js';
import aniworld from './stream/aniworld.js';
import reanime from './stream/reanime.js';
import fouranime from './stream/fouranime.js';
import anikoto from './stream/anikoto.js';
import animeheaven from './stream/animeheaven.js';
import anizone from './stream/anizone.js';
import animesalt from './stream/animesalt.js';
import animeblkom from './stream/animeblkom.js';
import desidub from './stream/desidub.js';
import moviebox from './stream/moviebox.js';

// ── Nuvio providers — Latino (18), Hindi (13), Multi-dub (11) ─────────────────
import { FRENCH_PROVIDERS } from './stream/nuvio/french/index.js';
import { LATINO_PROVIDERS } from './stream/nuvio/latino/index.js';
import { HINDI_PROVIDERS }  from './stream/nuvio/hindi/index.js';
import { MULTIDUB_PROVIDERS } from './stream/nuvio/multidub/index.js';

export const STREAM_PROVIDERS: StreamProvider[] = [
  nebula,
  animepahe,
  animeya,
  toonstream,
  animelok,
  watchanimeworld,
  aniworld,
  reanime,
  fouranime,
  anikoto,
  animeheaven,
  anizone,
  animesalt,
  animeblkom,
  desidub,
  moviebox,
  // Nuvio provider groups — appended after native providers so the fast anime
  // providers always answer first; these scrapers are slower by design.
  ...FRENCH_PROVIDERS,
  ...LATINO_PROVIDERS,
  ...HINDI_PROVIDERS,
  ...MULTIDUB_PROVIDERS,
];

// ── Torrent providers ─────────────────────────────────────────────────────────
import nyaa from './torrent/nyaa.js';
import animetosho from './torrent/animetosho.js';
import subplease from './torrent/subplease.js';
import seadex from './torrent/seadex.js';
import nekobt from './torrent/nekobt.js';
import aniliberty from './torrent/aniliberty.js';
export const TORRENT_PROVIDERS: TorrentProvider[] = [
  nyaa,
  animetosho,
  subplease,
  seadex,
  nekobt,
  aniliberty,
];

// ── Manga providers ───────────────────────────────────────────────────────────
// Order is priority order (same as stream providers). `mangadex` and `comick`
// lead: they are the deterministic mappers (the AniList/MAL id is stamped on
// each title — `attributes.links.al` on MangaDex, `links.al`/`links.mal` on
// Comick) and expose clean public JSON APIs. The HTML scrapers follow: mangapill
// and mangakatana serve images over plain HTTP, while weebcentral and nelomanga
// are Cloudflare-gated and fetch through the shared browser-bypass helper. All
// six map by title when the id link is absent, and the reader's cross-source
// fallback skips any source whose pages come back empty.
//
// Removed 2026-09: `allmanga` (AllAnime's `chapterPages` op now hard-returns
// NEED_CAPTCHA — chapters still list but pages are unfetchable without solving
// an interactive captcha the CF bypass cannot clear) and `mangaball` (its
// Laravel CSRF handshake now sits behind a Cloudflare 403 and was best-effort to
// begin with). The earlier `mangafire`/`animesama`/`asura` stubs stay dropped —
// none had working page extraction.
//
// 2026-09-26 re-probe of four requested sites: only `toongod` shipped (below).
// `mangadot.net` and `mangaball.net` sit behind a full-site Cloudflare *managed*
// challenge (`Cf-Mitigated: challenge` on every path, robots.txt/wp-json
// included) — not scrapable from CI, and mangadot's stack could not be
// fingerprinted to write selectors against, so both are held rather than shipped
// blind. `mangafire.to` is now a token-signed (`window.__config`) rolldown SPA
// whose reader images remain scramble-offset (canvas-descrambled, not plain
// URLs), so it stays infeasible per the "no scrambled pages" rule. `atsu` was re-added 2026-09: its JSON API
// (search → allChapters → read/chapter) has clean, verified page extraction and
// covers the Korean/Chinese webtoons the manga-first catalogues miss. `webtoons`
// (2026-09) is the official LINE Webtoon site — a plain-HTTP search + mobile
// episodes JSON + viewer scrape, best-in-class quality for the vertical-scroll
// titles it hosts, mapped by fuzzy title. `demonicscans` (2026-09) is a plain
// server-rendered aggregator: search.php → /manga/<Slug> chapter list →
// /chaptered.php 302→ reader; panels are `img.imgholder` on the mangareadon CDN
// (no hotlink protection, so images load direct with no proxy), fuzzy-mapped.
// `toongod` (2026-09) is a Madara/WordPress adult-manhwa site behind a full-site
// Cloudflare managed challenge; it fetches through the same browser-bypass helper
// as weebcentral/nelomanga. It leans on Madara's stable contract (admin-ajax
// search → `<detail>/ajax/chapters/` → `.reading-content img`) and the detail URL
// the search returns, so the post-type slug is never guessed. Panels hotlink-
// protect → Referer + local-proxy replay. Appended last (lowest priority) among
// the manga sources.
import mangadex from './manga/mangadex.js';
import comick from './manga/comick.js';
import mangapill from './manga/mangapill.js';
import mangakatana from './manga/mangakatana.js';
import weebcentral from './manga/weebcentral.js';
import nelomanga from './manga/nelomanga.js';
import atsu from './manga/atsu.js';
import webtoons from './manga/webtoons.js';
import demonicscans from './manga/demonicscans.js';
import toongod from './manga/toongod.js';

export const MANGA_PROVIDERS: MangaProvider[] = [
  mangadex,
  mangapill,
  mangakatana,
  weebcentral,
  nelomanga,
  comick,
  atsu,
  webtoons,
  demonicscans,
  toongod,
];

// ── Priority ──────────────────────────────────────────────────────────────────

/**
 * Providers that get a head start.
 *
 * `runProvidersProgressive` emits chunks in *completion* order under a 10-way
 * worker pool, and `sourcesAll` runs the stream and torrent pools concurrently —
 * so a provider's position in `STREAM_PROVIDERS` says nothing about when its
 * chunk arrives. Whichever site answers fastest on the day was landing first,
 * and the watch page, which maps sources positionally, autoplayed that one.
 *
 * Naming a provider here makes the runner emit its chunk before any other, so
 * the ordering the registry declares is the ordering the UI receives. The wait
 * is bounded (`LEAD_GRACE_MS` in provider-runner.ts): if the lead provider is
 * slow or empty, the rest are released rather than held.
 */
export const LEAD_STREAM_PROVIDERS: string[] = ['nebula'];

/**
 * Rank of a provider within its pool, lowest = highest priority.
 *
 * Stamped onto every `SourceResult` as `providerPriority` so ordering survives
 * the trip through the host, the SSE stream and the renderer's source list —
 * none of which preserve the order results were produced in. Torrent providers
 * are offset past the end of the stream list: a direct stream always outranks a
 * torrent, which needs a download before it plays. Unknown providers sort last.
 */
const STREAM_RANK = new Map(STREAM_PROVIDERS.map((p, i) => [p.name, i]));
const TORRENT_RANK = new Map(
  TORRENT_PROVIDERS.map((p, i) => [p.name, STREAM_PROVIDERS.length + i]),
);
const UNRANKED = STREAM_PROVIDERS.length + TORRENT_PROVIDERS.length + 1000;

export function providerPriorityOf(providerName: string | undefined | null): number {
  const name = String(providerName || '').trim().toLowerCase();
  if (!name) return UNRANKED;
  const stream = STREAM_RANK.get(name);
  if (stream !== undefined) return stream;
  const torrent = TORRENT_RANK.get(name);
  if (torrent !== undefined) return torrent;
  // Providers that suffix their name per language/server (`nebula-dub`,
  // `animepahe-1080p`) still belong to their base provider's rank.
  const base = name.split('-')[0];
  const baseStream = STREAM_RANK.get(base);
  if (baseStream !== undefined) return baseStream;
  const baseTorrent = TORRENT_RANK.get(base);
  return baseTorrent !== undefined ? baseTorrent : UNRANKED;
}
