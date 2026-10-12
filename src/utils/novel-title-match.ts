/** Preserve subtitles and sequel numbers when automatically matching novels. */
import { pickBestMangaCandidate } from './manga/manga-title-resolver.js';
const fullTitle = (value:string) => value.normalize('NFKC').toLowerCase().replace(/\((?:light\s*)?novel\)/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function pickBestNovelCandidate(titles:string[], candidates:Array<{id:string;title:string}>) {
 const targets=titles.map(fullTitle).filter(Boolean);
 const exact=candidates.find(row=>targets.includes(fullTitle(row.title)));
 if(exact)return {candidate:exact,score:1};
 const eligible=candidates.filter(row=>{
  const name=fullTitle(row.title);
  return targets.some(target=>{
   const ratio=Math.min(name.length,target.length)/Math.max(name.length,target.length);
   const numbers=(value:string)=>value.match(/\d+/g)?.join(',') || '';
   return ratio>=.85 && numbers(name)===numbers(target);
  });
 });
 return pickBestMangaCandidate(titles,eligible,row=>[row.title],.85);
}
