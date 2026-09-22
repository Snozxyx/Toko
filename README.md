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

## Release v3

Toko v3 includes the unified provider registry, progressive source delivery, language-aware filtering, subtitle aggregation, torrent metadata, and the download API.

## Coverage

The current registry contains **95 providers**:

| Category | Total | Coverage |
|:--|--:|:--|
| **Streaming** | **84** | Anime, movies, and TV with HLS, MP4, embeds, captions, and language metadata |
| **Torrent** | **6** | Magnet links, `.torrent` links, release metadata, file format, seeders, and leechers |
| **Manga** | **5** | Chapter listing, page fetching, and scanlator metadata |
| **Total** | **95** | Unified provider interface |

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
| **Stream** | 84 | Direct-stream sources across native anime, French, Latino, Hindi, and multi-dub providers |
| **Torrent** | 6 | Magnet links and torrent files |
| **Manga** | 5 | Chapters, pages, and scanlator metadata |

### Streaming

- 16 native anime/movie direct-stream providers
- 68 Nuvio-adapter stream providers across French, Latino, Hindi, and multi-dub catalogs
- MovieBox for movies & TV (direct MP4/HLS + captions)
- Support for single episodes
- Optional movie support
- Optional language information

#### Provider health audit (2026-08)

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

- 5 manga providers
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
