import { expect, test } from 'bun:test';
import justmanga from '../src/providers/manga/justmanga';
import TokoBundle from '../src/index';

async function mocked(run: () => Promise<void>, respond: (url: string) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async input => respond(String(input))) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('exact AniList mapping keeps server alternatives, chapter zero and fractional keys', async () => {
  await mocked(async () => {
    const chapters = await justmanga.getChapters({ anilistId: 105398 });
    expect(chapters.map(chapter => chapter.number)).toEqual([0, 1.5]);
    expect(chapters[0].sources.map(source => source.provider)).toEqual(['justmanga@mangaball', 'justmanga@mangadex']);
    expect(chapters[0].sources[0].providerName).toBe('JustManga · Mochi');
    expect(chapters[1].sources[0].chapterKey).toBe('justmanga@mangaball:105398|1.5_extra|en');
  }, url => {
    if (url.endsWith('/manga/105398')) return Response.json({ id: '105398', title: 'Solo Leveling', type: 'MANHWA' });
    if (url.includes('/servers')) return Response.json([{ source: 'mangaball', name: 'Mochi' }, { source: 'mangadex', name: 'Akira' }]);
    if (url.includes('/chapters?')) return Response.json({ chapters: [
      { id: 'zero', key: '0', number: 0, lang: 'en', group: 'Group A' },
      { id: 'fraction', key: '1.5_extra', number: 1.5, lang: 'en' },
      { id: 'duplicate', key: '0', number: 0, lang: 'en' },
      { id: 'invalid', key: 'bad', number: -1 },
    ] });
    throw Error(`Unexpected request: ${url}`);
  });
});

test('title fallback chooses the matching comic and excludes a same-name novel', async () => {
  await mocked(async () => {
    expect(await justmanga.getChapters({ titles: ['Fixture'] })).toEqual([]);
  }, url => {
    if (url.includes('/suggestions?')) return Response.json([{ id: 'novel', title: 'Fixture', type: 'NOVEL' }, { id: 'comic', title: 'Fixture', type: 'MANGA' }]);
    expect(url).toContain('/manga/comic/servers?');
    return Response.json([]);
  });
});

test('bundle routes JustManga server keys and preserves signed image queries and page order', async () => {
  await mocked(async () => {
    const pages = await new TokoBundle().getMangaPages({ chapterKey: 'justmanga@mangaball:105398|1.5_extra|en' });
    expect(pages.map(page => page.imageUrl)).toEqual([
      'https://core.justmanga.cc/api/image?url=https%3A%2F%2Fcdn.example%2F1.webp&exp=123&sig=fixture',
      'https://cdn.example/2.webp',
    ]);
    expect(pages.map(page => page.pageNumber)).toEqual([1, 2]);
    expect(pages[0].headers?.Referer).toBe('https://justmanga.cc/');
  }, url => {
    expect(url).toBe('https://core.justmanga.cc/api/manga/105398/chapters/1.5_extra/pages?source=mangaball&lang=en');
    return Response.json({ pages: [
      { index: 1, url: 'https://cdn.example/2.webp' },
      { index: 0, url: 'https://cdn.example/1.webp', proxy: 'url=https%3A%2F%2Fcdn.example%2F1.webp&exp=123&sig=fixture' },
    ] });
  });
});

test('blocked API requests remain errors and malformed chapter keys do not fetch', async () => {
  await mocked(async () => {
    await expect(justmanga.getChapters({ anilistId: 105398 })).rejects.toThrow('JustManga HTTP 403');
    expect(await justmanga.getPages('other:105398|1|en')).toEqual([]);
    expect(await justmanga.getPages('justmanga@mangaball:%xx|1|en')).toEqual([]);
  }, () => new Response('Blocked', { status: 403 }));
});

test('a failed server retains chapters from the healthy alternative', async () => {
  await mocked(async () => {
    const chapters = await justmanga.getChapters({ anilistId: 30013 });
    expect(chapters[0].sources[0].provider).toBe('justmanga@mangadex');
  }, url => {
    if (url.endsWith('/manga/30013')) return Response.json({ id: '30013', title: 'One Piece', type: 'MANGA' });
    if (url.includes('/servers')) return Response.json([{ source: 'mangaball', name: 'Mochi' }, { source: 'mangadex', name: 'Akira' }]);
    return url.includes('source=mangaball') ? new Response('Unavailable', { status: 502 }) : Response.json({ chapters: [{ key: '1', number: 1, lang: 'en' }] });
  });
});
