# Changelog

## 4.5.8 - 2026-10-28

- Preserve every Atsu upstream for each manga, novel, and webnovel chapter, with readable source labels and stable selections. Existing reading links remain supported.
- Add Manta chapter-novel search and public free chapters through its normal browser reader. Paid, membership, and Free Pass unlocks are not performed.
- Add Scribble Hub search, full chapter catalogs, and prose reading.
- Load Webnovel.com’s full catalog and canonical chapter URLs; include Webnovel, Royal Road, Atsu novels, Manta, and Scribble Hub in normal browser discovery.

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
