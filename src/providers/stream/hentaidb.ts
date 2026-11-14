import { getCatalog, episodeSources } from '../adult/hentaidb-client.js';
import type { StreamProvider } from '../../types/index.js';
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const provider:StreamProvider={name:'hentaidb',adultOnly:true,sites:['https://hentaidb.xyz'],async single(opts){
 if(opts.contentMode!=='adult')return [];
 const catalog=await getCatalog();const mapped=opts.sourceIds?.hentaidb;const titles=new Set(opts.titles.map(normalize));
 const series=mapped?catalog.bySlug.get(mapped):catalog.series.find(s=>titles.has(normalize(s.title)));
 if(!series)return [];const episode=opts.episode||1;if(episode>series.episodeCount)return [];
 return (await episodeSources(series.slug+'~'+episode)).map(source=>({...source,source:'HentaiDB · '+source.source,subtitles:source.subtitles.map(t=>({...t,language:t.language||'en'})),sourceType:source.sourceType==='hls'?'hls' as const:'mp4' as const,providerName:'HentaiDB',providerKey:'hentaidb'}));
}};
export default provider;
