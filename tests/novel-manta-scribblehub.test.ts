import { expect, test } from 'bun:test';
import manta from '../src/providers/novel/manta';
import scribblehub from '../src/providers/novel/scribblehub';
import { setCloudflareBrowserRuntime } from '../src/utils/common/cf-bypass';

test('Manta distinguishes prose editions, lists public chapters, and never opens locked chapters', async () => {
  const original = globalThis.fetch;
  const visits: string[] = [];
  let closed = 0;
  setCloudflareBrowserRuntime({ newBrowser: async () => ({ navigate: async url => { visits.push(url); },
    evaluate: async () => ({ origin: 'https://manta.net', paragraphs: ['Free chapter text.'] }),
    executeCDP: async () => ({}), sleep: async () => {}, close: async () => { closed++; } }) });
  globalThis.fetch = (async input => {
    const url = String(input);
    if (url.includes('/search/')) return Response.json({ data: [
      { id: 1, type: 10, data: { title: { en: 'Comic' } } }, { id: 2, type: 40, data: { title: { en: 'Web novel' } } },
      { id: 3, type: 30, data: { title: { en: 'Volume edition' } } },
    ] });
    const episodes = [{ id: 11, ord: 1, lockData: { state: 110 } }, { id: 12, ord: 2, lockData: { state: 20 } }];
    if (url.includes('/series/')) return Response.json({ data: { type: 40, episodes } });
    return Response.json({ data: { ...episodes[url.includes('/12?') ? 1 : 0], seriesId: 2, series: { type: 40 } } });
  }) as typeof fetch;
  try {
    expect((await manta.search!('novel')).map(row => row.id)).toEqual(['2']);
    const chapters = await manta.getChapters({ seriesId: '2' });
    expect(chapters.map(row => row.number)).toEqual([1]);
    expect((await manta.getContent(chapters[0].sources[0].chapterKey))?.paragraphs[0].text).toBe('Free chapter text.');
    expect(closed).toBe(1);
    expect(visits).toHaveLength(2);
    await expect(manta.getContent('manta:2|12')).rejects.toThrow('requires access');
    expect(visits).toHaveLength(2);
    expect(await manta.getContent('manta:999|11')).toBeNull();
  } finally { globalThis.fetch = original; setCloudflareBrowserRuntime(undefined); }
});

test('Scribble Hub requests the complete catalog and preserves unnumbered chapters', async () => {
  const original = globalThis.fetch;
  let posted = '';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes('?s=')) return new Response('<div class="search_title"><a href="/series/123/fixture/">Fixture</a></div>');
    if (url.includes('admin-ajax')) {
      posted = String(init?.body);
      return new Response('<li class="toc_w"><a class="toc_a" href="/read/123/fixture/chapter/2/">Next</a></li><li class="toc_w"><a class="toc_a" href="/read/123/fixture/chapter/1/">Prologue</a></li>');
    }
    return new Response('<div class="chp_raw"><p>First.</p><p>Second.</p><script>ignore</script></div>');
  }) as typeof fetch;
  try {
    const search = await scribblehub.search!('Fixture');
    const chapters = await scribblehub.getChapters({ seriesId: search[0].id });
    expect(new URLSearchParams(posted).get('pagenum')).toBe('-1');
    expect(chapters.map(row => row.title)).toEqual(['Prologue', 'Next']);
    expect((await scribblehub.getContent(chapters[0].sources[0].chapterKey))?.paragraphs.map(row => row.text)).toEqual(['First.', 'Second.']);
    await expect(scribblehub.getChapters({ seriesId: 'https://evil.example/series/123/fixture/' })).rejects.toThrow('Invalid');
  } finally { globalThis.fetch = original; }
});
