import { expect, test } from 'bun:test';
import manga from '../src/providers/manga/atsu';
import novel from '../src/providers/novel/atsu';
import TokoBundle from '../src/index';

test('Atsu keeps all manga and web-novel upstreams and routes their content', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async input => {
    const url = String(input);
    if (url.includes('/search/')) return Response.json({ hits: [{ document: { id: 'multi-comic', title: 'Upstream Fixture', medium: 'Comic' } }] });
    if (url.includes('/manga/page')) return Response.json({ mangaPage: { scanlators: [{ id: 'group-a', name: 'Asura' }, { id: 'group-b', name: 'NovelBuddy' }] } });
    if (url.includes('allChapters')) return Response.json({ chapters: [
      { id: 'chapter-a', number: 1, scanlationMangaId: 'group-a' },
      { id: 'chapter-b', number: 1, scanlationMangaId: 'group-b' },
      { id: 'chapter-a', number: 1, scanlationMangaId: 'group-a' },
      { id: 'prologue', number: 0, scanlationMangaId: 'group-b' },
    ] });
    if (url.includes('/read/novelChapter')) return Response.json({ readNovelChapter: { number: 1, paragraphs: ['Selected source text.'] } });
    if (url.includes('/read/chapter')) return Response.json({ readChapter: { pages: [{ image: '/static/pages/one.webp', number: 1 }] } });
    throw new Error(url);
  }) as typeof fetch;
  try {
    const comics = await manga.getChapters({ titles: ['Upstream Fixture'] });
    expect(comics.map(row => row.number)).toEqual([0, 1]);
    expect(comics[1].sources.map(source => source.provider)).toEqual(['atsu@group-a', 'atsu@group-b']);
    expect(comics[1].sources.map(source => source.providerName)).toEqual(['Atsu · Asura', 'Atsu · NovelBuddy']);
    const novels = await novel.getChapters({ seriesId: 'multi-novel' });
    expect(novels[1].sources).toHaveLength(2);
    const selected = await novel.getChapters({ seriesId: 'multi-novel', provider: 'atsu-novel@group-b' });
    expect(selected.every(row => row.sources.every(source => source.provider === 'atsu-novel@group-b'))).toBe(true);
    const bundle = new TokoBundle();
    const content = await bundle.getNovelContent({ chapterKey: novels[1].sources[1].chapterKey, provider: novels[1].sources[1].provider });
    expect(content.provider).toBe('atsu-novel@group-b');
    expect(content.paragraphs[0].text).toBe('Selected source text.');
    expect(await bundle.getMangaPages({ chapterKey: comics[1].sources[1].chapterKey })).toHaveLength(1);
    expect(await bundle.getMangaPages({ chapterKey: 'atsu:multi-comic|chapter-a' })).toHaveLength(1);
    expect((await novel.getContent('atsu-novel:multi-novel|chapter-a'))?.paragraphs).toHaveLength(1);
  } finally { globalThis.fetch = original; }
});
