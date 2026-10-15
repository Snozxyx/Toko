import { expect, test } from 'bun:test';
import atsu from '../src/providers/novel/atsu';
test('Atsu exposes prose chapters separately from comics and reads string paragraphs', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/api/search/'))
      return Response.json({
        hits: [
          { document: { id: 'comic', title: 'A Book', medium: 'Comic' } },
          { document: { id: 'novel-id', title: 'A Book', medium: 'Novel' } },
        ],
      });
    if (url.includes('allChapters'))
      return Response.json({
        chapters: [
          { id: 'ch2', number: 2, title: 'Second' },
          { id: 'ch1', number: 1, title: 'First' },
        ],
      });
    if (url.includes('/api/read/novelChapter'))
      return Response.json({
        readNovelChapter: {
          title: 'First',
          number: 1,
          paragraphs: ['First paragraph.', '', 'Second paragraph.'],
        },
      });
    throw new Error(url);
  }) as typeof fetch;
  try {
    expect((await atsu.search!('A Book')).map((row) => row.id)).toEqual([
      'novel-id',
    ]);
    const chapters = await atsu.getChapters({
      provider: 'atsu-novel',
      seriesId: 'novel-id',
    });
    expect(chapters.map((chapter) => chapter.number)).toEqual([1, 2]);
    const content = await atsu.getContent(chapters[0].sources[0].chapterKey);
    expect(content?.paragraphs.map((row) => row.text)).toEqual([
      'First paragraph.',
      'Second paragraph.',
    ]);
    expect(content?.provider).toBe('atsu-novel');
  } finally {
    globalThis.fetch = original;
  }
});
