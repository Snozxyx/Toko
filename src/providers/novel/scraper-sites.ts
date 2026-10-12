/** HTML provider contracts adapted from wongpinter/webnovel-scraper (MIT).
 * See THIRD_PARTY_NOTICES.md. No Python/native dependency is required.
 */
import type { NovelProvider, NovelChapterEntry, NovelContentEntry } from '../../types/index.js';
import { fetchTextWithBypass } from '../../utils/common/fetch-bypass.js';
import { fetchResponse, loadHtml } from '../../utils/http/fetch.js';
interface Site { name: string; base: string; search: (q: string) => string; series: RegExp; chapters: string; content: string; kind?: 'bin' | 'fire' | 'madara'; }
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
function createHtmlNovelProvider(site: Site): NovelProvider {
  function safeUrl(value: string, relative = site.base): string {
    const url = new URL(value, relative);
    if (url.origin !== new URL(site.base).origin || url.username || url.password) throw new Error(`Invalid ${site.name} URL`);
    return url.href;
  }
  async function html(url: string, referer?: string, method = 'GET') {
    const target = safeUrl(url);
    const response = await fetchResponse(target, {
      method,
      timeoutMs: 12000,
      headers: { ...(referer ? { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' } : {}) },
    });
    if (response.ok) return response.text();
    const result = await fetchTextWithBypass(target, {
      method,
      timeoutMs: 12000,
      bypassTimeoutMs: 12000,
      headers: { ...(referer ? { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' } : {}) },
    });
    if (!result) throw new Error(`${site.name} HTTP ${response.status}${response.status === 403 ? ' (access blocked)' : response.status === 410 ? ' (site unavailable)' : ''}`);
    return result;
  }
  return {
    name: site.name, sites: [site.base],
    async search(query) {
      const $ = loadHtml(await html(site.search(query))); const found = new Map<string, {id:string;title:string;url:string}>();
      $('a[href]').each((_, node) => {
        const a = $(node); let url: string;
        try { url = safeUrl(a.attr('href') || ''); } catch { return; }
        if (!site.series.test(new URL(url).pathname)) return;
        // Card headings, rather than whole cards (ratings and descriptions), determine title matching.
        const title = clean(a.attr('title') || a.find('h3,h4,.novel-title,.title').first().text() || a.find('img').attr('alt') || a.text());
        if (!title || title.length > 250) return;
        if (!found.has(url)) found.set(url, {id:url,title,url});
      });
      return [...found.values()].slice(0,30);
    },
    async getChapters(params) {
      if (!params.seriesId) return [];
      const series = safeUrl(params.seriesId); const initial = await html(series); const $ = loadHtml(initial);
      let listUrl = series, listHtml = initial;
      if (site.kind === 'bin') {
        const slug = new URL(series).pathname.split('/').filter(Boolean).pop()!;
        listUrl = `${site.base}/ajax/chapter-archive?novelId=${encodeURIComponent(slug)}`;
        listHtml = await html(listUrl, series);
            } else if (site.kind === 'fire') {
        listUrl = series.replace(/\/$/, '') + '/chapters'; listHtml = await html(listUrl, series);
      } else if (site.kind === 'madara' && $(site.chapters).length === 0) {
        listUrl = series.replace(/\/$/, '') + '/ajax/chapters/'; listHtml = await html(listUrl, series, 'POST');
      }
      const links = new Map<string,{url:string;label:string;number:number|null}>();
      const visited = new Set<string>(); const queue = [listUrl]; const pages = new Map([[listUrl,listHtml]]);
      const deadline = Date.now() + 26000;
      while (queue.length) {
        if (Date.now() > deadline) throw new Error(`${site.name} chapter catalog timed out; retry later.`);
        const batch = queue.splice(0,5).filter(url => !visited.has(url));
        await Promise.all(batch.map(async pageUrl => {
          visited.add(pageUrl); const page = loadHtml(pages.get(pageUrl) ?? await html(pageUrl, series));
          page(site.chapters).each((_,node)=>{
            const a=page(node); let url:string; try {url=safeUrl(a.attr('href') || '', pageUrl);} catch{return;}
            if (url===series || links.has(url)) return;
            const label=clean(a.attr('title') || a.text()); if(!label) return;
            const raw=label.match(/(?:chapter|ch\.?|episode)\s*[:#.-]?\s*(\d+(?:\.\d+)?)/i)?.[1] || new URL(url).pathname.match(/chapter[-_](\d+(?:\.\d+)?)/i)?.[1] || a.find('.chapter-no').text().trim();
            links.set(url,{url,label,number:raw && Number.isFinite(Number(raw)) ? Number(raw) : null});
          });
          page('.pagination a[href],a[rel="next"]').each((_,node)=>{
            let url:string;try{url=safeUrl(page(node).attr('href') || '',pageUrl)}catch{return}
            const path=new URL(url).pathname;
            if (path!==new URL(listUrl).pathname || visited.has(url) || queue.includes(url)) return;
            // Only follow catalog pagination, never the chapter reader's next link.
            if (!new URL(url).searchParams.has('page')) return;
            if(visited.size+queue.length>=100) throw new Error(`${site.name} catalog exceeds the 100-page limit.`);
            queue.push(url);
          });
        }));
      }
      const values=[...links.values()];
      // Madara often returns its list newest-first. Numeric titles are sorted below;
      // untitled-number chapters retain a stable oldest-first order.
      if(site.kind==='madara') values.reverse();
      return values.map((row,index):NovelChapterEntry=>({number:row.number ?? index+1,title:row.label,volume:null,sources:[{provider:site.name,chapterKey:`${site.name}:${encodeURIComponent(row.url)}`,providerChapterId:row.url,language:'en',translator:null,releaseDate:null}]})).filter(row=>row.number>0).sort((a,b)=>a.number-b.number);
    },
    async getContent(chapterKey):Promise<NovelContentEntry|null> {
      const prefix=`${site.name}:`;if(!chapterKey.startsWith(prefix)) throw new Error('Invalid novel chapter key');
      const url=safeUrl(decodeURIComponent(chapterKey.slice(prefix.length))); const $=loadHtml(await html(url));
      const body=$(site.content).first(); if(!body.length) return null;
      body.find('script,style,iframe,.ads,.advertisement,.adsbygoogle,.chapter-nav,.nav-buttons').remove();
      const paragraphs:string[]=[];
      body.find('p').each((_,node)=>{const text=clean($(node).text());if(text) paragraphs.push(text)});
      if(!paragraphs.length) { body.find('br').replaceWith('\n'); paragraphs.push(...body.text().split(/\n+/).map(clean).filter(Boolean)); }
      if(!paragraphs.length) return null;
      return {provider:site.name,title:clean($('.chapter-title,h1').first().text()) || null,number:null,paragraphs:paragraphs.map((text,index)=>({text,index}))};
    },
  };
}
export const scraperNovelProviders:NovelProvider[]=[
  {name:'novelfull',base:'https://novelfull.com',search:(q:string)=>`https://novelfull.com/search?keyword=${encodeURIComponent(q)}`,series:/^\/(?!search|chapter|index)[^/]+\.html\/?$/,chapters:'ul.list-chapter li a',content:'#chapter-content'},
  {name:'novelfire',base:'https://novelfire.net',search:(q:string)=>`https://novelfire.net/search?keyword=${encodeURIComponent(q)}`,series:/^\/book\/[^/]+\/?$/,chapters:'ul.chapter-list li a',content:'#content.clearfix, #content',kind:'fire'},
  {name:'novelbin',base:'https://novelbin.com',search:(q:string)=>`https://novelbin.com/search?keyword=${encodeURIComponent(q)}`,series:/^\/b\/[^/]+\/?$/,chapters:'ul.list-chapter li a,#tab-chapters a[href*="chapter-"]',content:'#chr-content',kind:'bin'},
  {name:'royalroad',base:'https://www.royalroad.com',search:(q:string)=>`https://www.royalroad.com/fictions/search?title=${encodeURIComponent(q)}`,series:/^\/fiction\/\d+\/[^/]+\/?$/,chapters:'tr.chapter-row td:first-child a[href]',content:'.chapter-inner.chapter-content'},
  {name:'wuxiaworldsite',base:'https://wuxiaworld.site',search:(q:string)=>`https://wuxiaworld.site/?s=${encodeURIComponent(q)}&post_type=wp-manga`,series:/^\/novel\/[^/]+\/?$/,chapters:'.wp-manga-chapter a',content:'.reading-content .text-left',kind:'madara'},
  {name:'readnovelfull',base:'https://readnovelfull.com',search:(q:string)=>`https://readnovelfull.com/search?keyword=${encodeURIComponent(q)}`,series:/^\/(?!search|chapter|index)[^/]+\.html\/?$/,chapters:'ul.list-chapter li a,.list-chapter a',content:'#chapter-content,.chapter-content'},
  {name:'novelcool',base:'https://www.novelcool.com',search:(q:string)=>`https://www.novelcool.com/search/?wd=${encodeURIComponent(q)}`,series:/^\/novel\/[^/]+\/?$/,chapters:'.wp-manga-chapter a,.chapter-list a',content:'.reading-content,.chapter-content',kind:'madara'},
  {name:'novgo',base:'https://novgo.net',search:(q:string)=>`https://novgo.net/?s=${encodeURIComponent(q)}&post_type=wp-manga`,series:/^\/novel\/[^/]+\/?$/,chapters:'.wp-manga-chapter a,.chapter-list a',content:'.reading-content,.chapter-content',kind:'madara'},
  {name:'relibrary',base:'https://www.re-library.com',search:(q:string)=>`https://www.re-library.com/?s=${encodeURIComponent(q)}`,series:/^\/novel\/[^/]+\/?$/,chapters:'.wp-manga-chapter a,.chapter-list a',content:'.reading-content,.entry-content',kind:'madara'},
  {name:'woopread',base:'https://woopread.com',search:(q:string)=>`https://woopread.com/?s=${encodeURIComponent(q)}&post_type=wp-manga`,series:/^\/novel\/[^/]+\/?$/,chapters:'.wp-manga-chapter a,.chapter-list a',content:'.reading-content,.entry-content',kind:'madara'},
].map(site=>createHtmlNovelProvider(site as Site));
