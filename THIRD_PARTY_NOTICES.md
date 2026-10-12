# Novel provider attribution

The provider contracts, selectors, and chapter discovery patterns in
`src/providers/novel/scraper-sites.ts` are adapted from
https://github.com/wongpinter/webnovel-scraper (revision below),
Copyright (c) 2024 Web Novel Downloader, under the MIT license.
The full notice is preserved in `src/providers/novel/wn-dl-LICENSE.txt`.

Tatakai uses TypeScript adapters, automatic title search, and the existing
native mobile HTTP bridge. It does not bundle the Python CLI, EPUB generators,
cloudscraper, or a browser automation dependency from that project.
59917604ecce5dc9ab45212c998449149c52610b
