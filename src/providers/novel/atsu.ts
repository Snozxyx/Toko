/** Atsumaru novels use allChapters plus read/novelChapter, not manga image pages. */
import type { NovelProvider, NovelChapterEntry } from '../../types/index.js';
import { fetchJson } from '../../utils/http/fetch.js';
import { resolveMangaTitles } from '../../utils/manga/manga-title-resolver.js';
import { pickBestNovelCandidate } from '../../utils/novel-title-match.js';
const BASE = 'https://atsu.moe';
interface Doc { id: string; title: string; medium?: string; otherNames?: string[]; anilistId?: number; }
async function search(query: string): Promise<Doc[]> {
  const result = await fetchJson<{hits?: {document: Doc}[]}>(`${BASE}/api/search/manga?q=${encodeURIComponent(query)}&query_by=title`, { timeoutMs: 12000 });
  return (result.hits || []).map(hit => hit.document).filter(doc => doc?.id && doc.medium?.toLowerCase() === 'novel');
}
const provider: NovelProvider = {
  name: 'atsu-novel', sites: [BASE],
  async search(query) { return (await search(query)).map(doc => ({ id:doc.id,title:doc.title,url:`${BASE}/manga/${doc.id}` })); },
  async getChapters(params): Promise<NovelChapterEntry[]> {
    let seriesId = params.seriesId;
    if (!seriesId) {
      const titles = await resolveMangaTitles(params);
      const docs: Doc[] = [];
      for (const title of titles.slice(0,2)) docs.push(...await search(title));
      seriesId = docs.find(doc => params.anilistId && Number(doc.anilistId) === params.anilistId)?.id;
      seriesId ||= pickBestNovelCandidate(titles,docs.flatMap(doc => [doc.title,...(doc.otherNames || [])].map(title => ({id:doc.id,title}))))?.candidate.id;
    }
    if (!seriesId || !/^[\w-]+$/.test(seriesId)) return [];
    const result = await fetchJson<{chapters?: {id:string;number:number;title?:string;createdAt?:number}[]}>(`${BASE}/api/manga/allChapters?mangaId=${encodeURIComponent(seriesId)}`, {timeoutMs:15000});
    return (result.chapters || []).filter(chapter => chapter.id && Number.isFinite(Number(chapter.number)) && Number(chapter.number)>0).map(chapter => ({
      number:Number(chapter.number),title:chapter.title || null,volume:null,
      sources:[{provider:'atsu-novel',chapterKey:`atsu-novel:${seriesId}|${chapter.id}`,providerChapterId:chapter.id,language:'en',translator:null,releaseDate:chapter.createdAt ? new Date(chapter.createdAt).toISOString() : null}],
    })).sort((a,b)=>a.number-b.number);
  },
  async getContent(key) {
    const match = key.match(/^atsu-novel:([\w-]+)\|([\w-]+)$/);
    if (!match) return null;
    const result = await fetchJson<{readNovelChapter?: {title?:string;number?:number;paragraphs?:string[]}}>(`${BASE}/api/read/novelChapter?mangaId=${encodeURIComponent(match[1])}&chapterId=${encodeURIComponent(match[2])}`, {timeoutMs:15000});
    const chapter = result.readNovelChapter;
    const paragraphs = (chapter?.paragraphs || []).filter(text => typeof text === 'string' && text.trim()).map((text,index)=>({text:text.trim(),index}));
    return paragraphs.length ? { provider:'atsu-novel',title:chapter?.title || null,number:chapter?.number ?? null,paragraphs } : null;
  },
};
export default provider;
