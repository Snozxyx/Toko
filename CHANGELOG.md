# Changelog

## 4.5.7 - 2026-10-26

- Fix novel adapters incorrectly rejecting prose titles through the manga format matcher.
- Stream early manga and novel sources to compatible servers while retaining later provider results.

## 4.5.6 - 2026-10-26

- Bound manga and novel discovery, metadata waits and retry concurrency.
- Preserve later novel providers when invoked by a short-lived hosted worker.
- Normalize novel chapters to ordered text, excluding images and media URLs.

## 4.5.5 - 2026-10-15

- Add a dedicated Atsu prose-novel provider, keeping novels separate from comics.
- Read ordered chapter lists and normalized paragraphs from Atsu novel endpoints.
- Advertise novel capabilities and routes in the standalone API health response.

Update or reinstall toko.kai in Tatakai to use the new provider.
