/** Preserve subtitles and sequel numbers when automatically matching novels. */
import { scoreMatch } from './scraping/title-normalizer.js';
const fullTitle = (value:string) => value.normalize('NFKC').toLowerCase().replace(/\((?:light\s*)?novel\)/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
/** Anime query normalization removes "Part N"; novel parts are distinct works. */
export function buildNovelSearchQueries(titles: string[]): string[] {
 const seen = new Set<string>();
 return titles.map(title=>title.normalize('NFKC').replace(/\((?:light\s*)?novel\)/gi,'').replace(/\s+/g,' ').trim()).filter(title=>{
  const key=title.toLowerCase();if(!key||seen.has(key))return false;seen.add(key);return true;
 });
}
export function pickBestNovelCandidate(titles:string[], candidates:Array<{id:string;title:string}>) {
 const part=(value:string)=>value.match(/\bpart\s*(\d+)\b/i)?.[1];
 const requestedParts=[...new Set(titles.map(part).filter(Boolean))];
 const scopedTitles=requestedParts.length===1 ? titles.filter(title=>part(title)===requestedParts[0]) : titles;
 const targets=scopedTitles.map(fullTitle).filter(Boolean);
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
 const ranked=eligible.map(candidate=>({candidate,score:Math.max(0,...targets.map(target=>scoreMatch(target,fullTitle(candidate.title))))})).filter(row=>row.score>=.85).sort((a,b)=>b.score-a.score);
 return ranked[0] || null;
}

/** Adapt provider aliases without applying manga's intentional novel rejection. */
export function pickBestNovelProviderCandidate<T>(titles:string[],candidates:T[],getNames:(candidate:T)=>Array<string|null|undefined>,threshold=.85):{candidate:T;score:number}|null {
 const aliases=candidates.flatMap((candidate,index)=>getNames(candidate).filter((title):title is string=>typeof title==='string' && !!title.trim()).map(title=>({id:String(index),title})));
 const best=pickBestNovelCandidate(titles,aliases);
 return best && best.score>=Math.max(.85,threshold) ? {candidate:candidates[Number(best.candidate.id)],score:best.score} : null;
}
