/** Author-published Japanese prose on Shosetsuka ni Naro. */
import type { NovelProvider, NovelChapterEntry } from '../../types/index.js';
import { loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
const BASE = 'https://ncode.syosetu.com';
// The author's Part 5 starts at /461/ and ends at /677/. Keep its identity
// separate from the whole work and from English catalogs of earlier parts.
const SERIES = 'n4830bu';
const START = 461, END = 677;
const partFive = (query: string) => /(?:part\s*5\b|dai\s*5\s*[- ]?bu\b|第五部|avatar of a goddess)/i.test(query);
const bookworm = (query: string) => /ascendance of a bookworm|honzuki no gekokujou|本好きの下剋上/i.test(query)
  && !/fanfic|hannelore|mother and daughter|side stor/i.test(query);
const provider: NovelProvider = {
  name: 'syosetu', sites: [BASE],
  async search(query) {
    return bookworm(query) && partFive(query) ? [{id:`${SERIES}:5`,title:query,url:`${BASE}/${SERIES}/461/`}] : [];
  },
  async getChapters(params): Promise<NovelChapterEntry[]> {
    if (params.seriesId !== `${SERIES}:5`) return [];
    const catalogs = await Promise.all([5,6,7].map(page => fetchNovelSearchHtml(`${BASE}/${SERIES}/?p=${page}`)));
    const chapters = new Map<number, NovelChapterEntry>();
    for (const html of catalogs) {
      const $ = loadHtml(html);
      $('.p-eplist__subtitle').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(new RegExp(`^/${SERIES}/(\\d+)/$`));
        if (!match) return;
        const originalNumber = Number(match[1]);
        if (originalNumber < START || originalNumber > END) return;
        const number = originalNumber - START + 1;
        chapters.set(number, {number,title:$(el).text().trim(),volume:null,sources:[{
          provider:'syosetu',chapterKey:`syosetu:${SERIES}:5:${originalNumber}`,providerChapterId:`${SERIES}:5:${originalNumber}`,
          language:'ja',translator:'Author original (Japanese)',releaseDate:null,
        }]});
      });
    }
    if (chapters.size !== END - START + 1) throw new Error('Syosetu Part 5 catalog is incomplete; retry later.');
    return [...chapters.values()].sort((a,b)=>a.number-b.number);
  },
  async getContent(key) {
    const match = key.match(/^syosetu:n4830bu:5:(\d+)$/);
    if (!match) return null;
    const originalNumber = Number(match[1]);
    if (originalNumber < START || originalNumber > END) return null;
    const $ = loadHtml(await fetchNovelSearchHtml(`${BASE}/${SERIES}/${originalNumber}/`));
    const body = $('.p-novel__text').not('.p-novel__text--preface,.p-novel__text--afterword').first();
    body.find('script,style,rt,rp').remove();
    const texts: string[] = [];
    body.find('p').each((_, el)=>{const text=$(el).text().trim();if(text)texts.push(text)});
    return texts.length ? {provider:'syosetu',title:$('.p-novel__title--rensai').text().trim() || null,number:originalNumber-START+1,paragraphs:texts.map((text,index)=>({text,index}))} : null;
  },
};
export default provider;
