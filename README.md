# Toko — Unified Tatakai Extension

<p align="center">
  <img src="./icon.png" width="120" alt="Toko logo">
</p>

<p align="center">
  <strong>One extension for all your Tatakai providers.</strong><br>
  A unified <code>.kai</code> extension for anime streaming, torrent indexing, and manga providers.
</p>

<p align="center">
  <a href="#coverage">Coverage</a> •
  <a href="#features">Features</a> •
  <a href="#download-api">Download API</a> •
  <a href="#building">Building</a> •
  <a href="#development">Development</a> •
  <a href="#provider-architecture">Architecture</a>
</p>

---

## Release v4

### Webnovels and Atsu sources in v4.5.8

- Atsu exposes each available upstream separately (for example Asura, Alpha, Flame, and Dusk for manga, or System and NovelBuddy for novels). Shared chapter numbers keep every source; chapter zero and saved older reading links are supported.
- Manta searches chapter novels separately from comics and volume editions. Only publicly free/open chapters are listed. Text is read through the site's normal browser reader, so the host must provide a browser (or the API server must have its browser runtime available). Toko does not unlock paid chapters, claim Free Passes, or decrypt EPUB downloads.
- Scribble Hub provides original webnovels with a complete chapter catalog, including prologues and side stories. Site challenges may require the host's browser/native HTTP support.
- Webnovel.com remains a named provider, now using its catalog page and actual chapter links. Webnovel and Royal Road are included in hosted browser discovery; restricted chapters and site challenges may still prevent reading from individual providers.


### Novel provider repairs in v4.5.3

- NovelBuddy searches with `q`, loads the complete public chapter archive, refreshes stale Next.js build IDs, and uses published chapter numbers rather than sorting ordinals.
- NovelCool uses its own search and chapter markup. Re:Library uses its translation pages; Novgo uses its paginated catalog; WoopRead loads its complete embedded catalog.
- Novel requests detect challenge pages even when the server returns HTTP 200. The desktop host supplies its permitted provider browser to portable bundles.
- NovelCool, Toonily, OniSaga, and ToonGod are also searched for novels. A chapter must return prose before a mixed catalog is offered in the novel reader; comic panel readers are rejected.
- Request errors remain visible in diagnostics. Empty results can still mean a title is unavailable from a provider; access restrictions and unavailable sites can still prevent individual providers from answering.
- Normal novel discovery starts public catalogs first and returns the first readable source within an eight-second provider budget. Later results are retained and the app updates the source list while checks finish. An explicit full scan keeps the longer challenge-solving budget.
- Novel queries preserve parts/subtitles, successful pages are cached, simultaneous catalog requests are shared, and recently blocked providers are not retried for every alias and title. A valid empty HTTP answer does not trigger a duplicate IPC scan.
- Ascendance of a Bookworm: Part 5 is available from its author's Syosetu publication as 217 Japanese chapters (original chapters 461–677), kept separate from earlier English catalogs and labeled Japanese.
- Android and iOS use the same registered native proxy route. Native clearance is replayed for POST catalogs, and HTTP 200 challenge pages are recognized. The portable bundle does not try to launch Node/Puppeteer in a mobile WebView.
- On mobile, the fast scan uses public catalogs; the full scan also checks browser-challenged sources. This keeps a slow challenge from occupying the native request slots needed for the next novel.

Toko v4 is a full cleanup and stabilization release. It includes provider health audits with live-mirror repairs, removal of dead/broken providers, a full provider registry rebuild, progressive source delivery, language-aware filtering, subtitle aggregation, torrent metadata, and the download API.

## Coverage

The current registry contains **104 providers**:

| Category | Total | Coverage |
|:--|--:|:--|
| **Streaming** | **82** | Anime, movies, and TV with HLS, MP4, embeds, captions, and language metadata |
| **Torrent** | **6** | Magnet links, `.torrent` links, release metadata, file format, seeders, and leechers |
| **Manga** | **16** | Chapter listing, page fetching, and scanlator metadata |
| **Total** | **104** | Unified provider interface |

### Language support

Provider adapters recognize and normalize the following audio and subtitle languages:

- **Japanese** — original audio, Japanese subtitles, and Japanese-audio releases
- **English** — English dub and English subtitles
- **French** — French dub, French subtitles, VOSTFR, and Quebec/Belgian variants
- **Spanish** — Spanish, Castilian Spanish, Latin American Spanish, and regional tags
- **Portuguese** — Portuguese and Brazilian Portuguese
- **South Asian languages** — Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali, Marathi, Punjabi, and Urdu
- **Other languages** — Korean, Chinese, Arabic, German, Russian, Italian, and Polish
- **Multi-audio** — dual-audio and multi-audio releases

Language filters accept ISO-style codes and provider labels. Subtitle tracks are returned with their URL, label, language, and default-track flag when the provider exposes them.

## Features

Toko is the official unified extension for the [Tatakai](https://github.com/snozxyx/tatakai) platform. It consolidates multiple providers into a single installable `.kai` package.

| Category | Providers | Capabilities |
|:--|:--:|:--|
| **Stream** | 82 | Direct-stream sources across native anime, French, Latino, Hindi, and multi-dub providers |
| **Torrent** | 6 | Magnet links and torrent files |
| **Manga** | 16 | Chapters, pages, and scanlator metadata |

### Streaming

- 24 native anime/movie direct-stream providers
- 58 Nuvio-adapter stream providers across French, Latino, Hindi, and multi-dub catalogs
- MovieBox for movies & TV (direct MP4/HLS + captions)
- Support for single episodes
- Optional movie support
- Optional language information

#### Provider health audit (v4)

Every provider was checked against its live origin and repaired, kept, or removed:

| Verdict | Providers | Notes |
|:--|:--|:--|
| ✅ Working | nebula, animepahe, animeya, animelok, aniworld, reanime, fouranime, anikoto, animeheaven, anizone, animeblkom, desidub | Domain rot repaired where sites moved (animesalt → .cx, toonstream → toon-stream.site, anikoto → .cz, animepahe → .pw) |
| 🔧 Repaired | toonstream, anizone, animesalt | New live mirrors; ToonStream download-table extraction; AniZone plain-HTML search fallback |
| ➕ Added | moviebox | Ported from [walterwhite-69/Moviebox-API](https://github.com/walterwhite-69/Moviebox-API) — guest-JWT auth, search, direct MP4/HLS streams, captions, embed fallback |
| ♻️ Restored | watchanimeworld | Rebuilt for the successor domain watchanimeworld.one (Cloudflare-aware, player1 server-list extraction) |
| ❌ Removed | senshi, mkissa, acgrip | Backend 500s (senshi), reCAPTCHA-gated for non-browser clients (mkissa), dead RSS + dead tracker (acgrip) |

### Torrent

- 6 torrent indexers
- Magnet link support
- Torrent file support
- Batch searching through a unified provider interface

### Manga

- 16 manga providers
- Chapter listing and retrieval
- Page fetching
- Scanlator metadata

---

## Download API

The API runs on port `8099` and returns download-ready sources for one AniList episode:

```text
GET /download/:anilistId/:episode?lang=&type=
GET /api/v3/toko/download/:anilistId/:episode?lang=&type=
```

- `lang` is optional and accepts one language or comma-separated language values. It matches audio languages and subtitle tracks.
- `type` supports `all`, `stream`, `hls`, `m3u8`, `mp4`, `torrent`, and `mkv`.
- Responses are **Server-Sent Events by default**, so each source and provider status is returned as scraping completes.
- Add `stream=0` for one final JSON response.
- Each source includes its URL, provider, quality, audio language, subtitles, and required headers. Torrent sources also include title, file format, file size, magnet/torrent URL, seeders, leechers, peers, match score, and release group when available.

---

## Building

Build the extension with npm:

```bash
npm run build
```

This writes `dist/bundle.js` and the installable `dist/toko.kai` package.

---

## Installation

Install the extension in Tatakai by sideloading `dist/toko.kai` from the Extensions settings page.

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build
```

The build script (`build.ts`) bundles `src/index.ts` with esbuild (CJS, all deps inlined except Node built-ins) and packages it with the manifest and icon into a `.kai` ZIP archive.

## Deploying the API to Wasmer Edge

The API is configured as a Wasmer app in `app.yaml`. Replace `<YOUR-NAME>`
with your Wasmer username, then build and deploy from the repository root:

```bash
npm run build:api
wasmer deploy
```

Wasmer supplies the `PORT` environment variable at runtime. The API bootstrap
installs the API's production dependencies on first start, and the health check
is available at `/api/v3/health`.

## Novel sources (4.3.2)

Automatic AniList title matching now also searches NovelFull, NovelFire,
NovelBin, NovelBuddy, RoyalRoad, and wuxiaworld.site. These TypeScript adapters
use the provider contracts from wongpinter/webnovel-scraper; attribution and the
MIT license are included in the bundle. They run in desktop and native mobile
without Python. The official Wuxiaworld.com adapter remains separate.

Chapter catalogs support pagination and the NovelBin/NovelBuddy/Madara AJAX
routes. HTTP access failures are reported through novel diagnostics. A site
returning 403 or 410 cannot be treated as a successful empty catalog.
