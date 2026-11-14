import { load } from 'cheerio';
import type { StreamProvider } from '../../types/index.js';
import { fetchResponse } from '../../utils/http/fetch.js';
const BASE='https://hstream.moe';
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const provider:StreamProvider={name:'hstream',adultOnly:true,sites:[BASE],async single(opts){
 if(opts.contentMode!=='adult')return [];
 const episode=opts.episode||1;let slug=opts.sourceIds?.hstream;
 if(!slug){const home=await fetchResponse(BASE);const $home=load(await home.text());const token=$home('form[action$="/search"] input[name="_token"]').first().attr('value');if(!token)throw new Error('Hstream search token missing');const cookie=home.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');const res=await fetchResponse(BASE+'/search',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,Referer:BASE+'/'},body:new URLSearchParams({'_token':token,'live-search':opts.titles[0]||''}).toString()});const $=load(await res.text());const wanted=new Set(opts.titles.map(t=>normalize(t)+episode));$('a[href*="/hentai/"]').each((_,a)=>{const href=$(a).attr('href')||'';const name=$(a).attr('title')||$(a).text().replace(/4k|FHD|48fps/gi,'').trim();const candidate=href.split('/hentai/')[1]?.split('?')[0];if(wanted.has(normalize(name.replace(/episode/i,''))) || (candidate && wanted.has(normalize(candidate))))slug=candidate;});}
 if(!slug)return [];const url=BASE+'/hentai/'+encodeURIComponent(slug);const page=await fetchResponse(url);if(!page.ok)throw new Error('Hstream page unavailable');const $=load(await page.text());const id=$('#e_id').attr('value');if(!id)throw new Error('Hstream player ID missing');
 const cookies=page.headers.getSetCookie().map(c=>c.split(';')[0]);const xsrf=cookies.find(c=>c.startsWith('XSRF-TOKEN='));if(!xsrf)throw new Error('Hstream session token missing');
 const response=await fetchResponse(BASE+'/player/api',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Cookie:cookies.join('; '),'X-XSRF-TOKEN':decodeURIComponent(xsrf.slice(11)),Referer:url},body:JSON.stringify({episode_id:id})});if(!response.ok)throw new Error('Hstream player API returned '+response.status);
 const data=await response.json() as {stream_url?:string;stream_domains?:string[]};if(!data.stream_url||!Array.isArray(data.stream_domains))throw new Error('Invalid Hstream player response');
 return data.stream_domains.map((domain,index)=>({source:'Hstream · Server '+(index+1),url:domain+'/'+data.stream_url+'/x264.720p.mp4',quality:'720p',headers:{Referer:BASE+'/'},subtitles:[{url:domain+'/'+data.stream_url+'/eng.vtt',label:'English',language:'en'}],sourceType:'mp4' as const,providerName:'Hstream',providerKey:'hstream',audioLanguage:'ja'}));
}};
export default provider;
