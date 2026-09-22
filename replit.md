# Toko API on Replit

## Run

The API runs through the `Toko API` workflow:

```bash
npm --prefix api start
```

It listens on port `8099`.

## Download endpoint

```text
GET /download/:anilistId/:episode?lang=&type=
```

The versioned equivalent is:

```text
GET /api/v3/toko/download/:anilistId/:episode?lang=&type=
```

- `lang` is optional and accepts a language code/name or comma-separated values. It matches audio languages and subtitle tracks.
- `type` is optional and supports `all`, `stream`, `hls`, `m3u8`, `mp4`, `torrent`, and `mkv`.
- The response includes direct HLS/MP4 URLs, torrent/magnet links, provider and quality information, audio language, subtitles, and torrent metadata.
- Responses are SSE by default, using `source`, `provider_status`, and `done` events like the source endpoints. Add `stream=0` for one final JSON response.
