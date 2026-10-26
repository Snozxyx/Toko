/** Wuxiaworld: search the public catalog, then load the matched chapter list. */
import type { NovelProvider, NovelChapterParams } from '../../types/index.js';
import { loadHtml } from '../../utils/http/fetch.js';
import { resolveMangaTitles } from '../../utils/manga/manga-title-resolver.js';
import { pickBestNovelProviderCandidate } from '../../utils/novel-title-match.js';
import { wuxiaRpc, pbString, pbBytes, pbInt, concat, pbMessages, pbText, pbNumber } from './wuxia-rpc.js';
const BASE = 'https://www.wuxiaworld.com';
async function search(query: string) {
  const response = await wuxiaRpc('Novels', 'SearchNovels', concat(pbBytes(1, pbString(1, query)), pbInt(7, 20)));
  return pbMessages(response, 1).map(row => ({ id: pbText(row, 3), title: pbText(row, 2), url: BASE + '/novel/' + pbText(row, 3) })).filter(row => row.id && row.title);
}
async function match(params: NovelChapterParams) {
  if (params.seriesId) return params.seriesId;
  const titles = await resolveMangaTitles(params);
  const candidates = (await Promise.all(titles.slice(0, 2).map(search))).flat();
  return pickBestNovelProviderCandidate(titles, candidates, row => [row.title], .6)?.candidate.id;
}
const provider: NovelProvider = {
  name: 'wuxiaworld', sites: [BASE, 'https://api2.wuxiaworld.com'], search,
  async getChapters(params) {
    const slug = await match(params); if (!slug) return [];
    if (!/^[\w-]+$/.test(slug)) throw new Error('Invalid Wuxiaworld novel slug');
    const novel = pbMessages(await wuxiaRpc('Novels', 'GetNovel', pbString(2, slug)), 1)[0];
    if (!novel) return [];
    const response = await wuxiaRpc('Chapters', 'GetChapterList', pbInt(1, pbNumber(novel, 1)));
    const chapters = pbMessages(response, 1).flatMap(group => pbMessages(group, 6));
    return chapters.map((row, index) => {
      const chapterSlug = pbText(row, 3);
      return { number: pbNumber(row, 4) || index + 1, title: pbText(row, 2), volume: null,
        sources: [{ provider: 'wuxiaworld', chapterKey: 'wuxiaworld:' + slug + ':' + chapterSlug, providerChapterId: slug + ':' + chapterSlug, language: 'en', translator: null, releaseDate: null }] };
    }).filter(row => row.sources[0].chapterKey.split(':')[2]).sort((a,b) => a.number - b.number);
  },
  async getContent(key) {
    const rest = key.startsWith('wuxiaworld:') ? key.slice(11) : key;
    const [novelSlug, chapterSlug] = rest.split(':');
    if (!novelSlug || !chapterSlug || !/^[\w-]+$/.test(novelSlug) || !/^[\w-]+$/.test(chapterSlug)) return null;
    const slugs = concat(pbString(1, novelSlug), pbString(2, chapterSlug));
    const response = await wuxiaRpc('Chapters', 'GetChapter', pbBytes(1, pbBytes(2, slugs)));
    const item = pbMessages(response, 1)[0]; if (!item) return null;
    const content = pbMessages(item, 5)[0];
    const html = content ? pbText(content, 1) : pbMessages(item, 21).map(p => { const c = pbMessages(p, 4)[0]; return c ? pbText(c, 1) : ''; }).join('\n');
    const $ = loadHtml('<div id="body">' + html + '</div>');
    $('script,style').remove();
    const texts: string[] = [];
    $('#body p').each((_, el) => { const text = $(el).text().trim(); if (text) texts.push(text); });
    if (!texts.length) texts.push(...$('#body').text().split(/\n+/).map(t=>t.trim()).filter(Boolean));
    if (!texts.length) return null;
    return { provider: 'wuxiaworld', title: pbText(item, 2), number: pbNumber(item, 4) || null, paragraphs: texts.map((text,index)=>({index,text})) };
  },
};
export default provider;
