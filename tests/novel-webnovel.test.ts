import { expect, test } from 'bun:test';
import webnovel from '../src/providers/novel/webnovel';

test('Webnovel reads its full catalog and follows canonical chapter links', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/catalog')) return new Response('<div class="volume-item"><a href="/book/fixture_123456789/awakening_987654321">Chapter 1 Awakening</a><a href="https://evil.example/book/123456789/chapter_111111">Chapter 2</a></div>');
    return new Response('<h1 class="cha-tit">Awakening</h1><div class="cha-words"><p>Public chapter text.</p></div>');
  }) as typeof fetch;
  try {
    const chapters = await webnovel.getChapters({ seriesId: '123456789' });
    expect(chapters).toHaveLength(1);
    expect(calls[0]).toEndWith('/catalog');
    expect((await webnovel.getContent(chapters[0].sources[0].chapterKey))?.paragraphs[0].text).toBe('Public chapter text.');
    expect(calls.at(-1)).toContain('/awakening_987654321');
    const count = calls.length;
    expect(await webnovel.getContent('webnovel:123:bad')).toBeNull();
    expect(calls).toHaveLength(count);
  } finally { globalThis.fetch = original; }
});
