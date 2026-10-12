/** HTML provider contracts adapted from wongpinter/webnovel-scraper (MIT).
 * See THIRD_PARTY_NOTICES.md. No Python/native dependency is required.
 */
import type { NovelProvider, NovelChapterEntry, NovelContentEntry } from '../../types/index.js';
import { loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
interface Site { name: string; base: string; search: (q: string) => string; series: RegExp; chapters: string; content: string; kind?: 'bin' | 'fire' | 'madara' | 'wordpress' | 'novgo'; mixed?: boolean; }
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
function flightChapterCatalog($: ReturnType<typeof loadHtml>): any[] | null {
  let flight = '';
  $('script').each((_, el) => {
    const match = $(el).text().match(/self\.__next_f\.push\((\[.*\])\)/s);
    if (!match) return;
    try { const value = JSON.parse(match[1])[1]; if (typeof value === 'string') flight += value; } catch {}
  });
  const start = flight.indexOf('"chapters":[');
  if (start < 0) return null;
  const arrayStart = start + '"chapters":'.length;
  let depth = 0, quoted = false, escaped = false;
  for (let i = arrayStart; i < flight.length; i++) {
    const char = flight[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      try { return JSON.parse(flight.slice(arrayStart, i + 1)); } catch { return null; }
    }
  }
  return null;
}
function createHtmlNovelProvider(site: Site): NovelProvider {
  function safeUrl(value: string, relative = site.base): string {
    const url = new URL(value, relative);
    if (url.origin !== new URL(site.base).origin || url.username || url.password) throw new Error(`Invalid ${site.name} URL`);
    return url.href;
  }
  async function html(url: string, referer?: string, method = 'GET') {
    const target = safeUrl(url);
    return fetchNovelSearchHtml(target, {
      method,
      timeoutMs: 12000,
      headers: { ...(referer ? { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' } : {}) },
    });
  }
  return {
    name: site.name, sites: [site.base],
    async search(query) {
      const $ = loadHtml(await html(site.search(query))); const found = new Map<string, {id:string;title:string;url:string}>();
      $(site.kind === 'wordpress' ? '.entry-content a[href]' : 'a[href]').each((_, node) => {
        const a = $(node); let url: string;
        try { url = safeUrl(a.attr('href') || ''); } catch { return; }
        if (!site.series.test(new URL(url).pathname) || new URL(url).search || new URL(url).hash) return;
        // Card headings, rather than whole cards (ratings and descriptions), determine title matching.
        const title = clean(a.closest('.book-item').find('.book-name').first().text() || a.find('h2,h3,h4,.novel-title,.book-name,.title').first().text() || a.attr('title') || a.find('img').attr('alt') || a.text()).replace(/^Cover image for\s+/i, '');
        if (!title || title.length > 250) return;
        if (site.kind === 'wordpress' && !title.toLowerCase().includes(query.toLowerCase())) return;
        if (!found.has(url)) found.set(url, {id:url,title,url});
      });
      return [...found.values()].slice(0,30);
    },
    async getChapters(params) {
      if (!params.seriesId) return [];
      const series = safeUrl(params.seriesId); const initial = await html(series); const $ = loadHtml(initial);
      if (site.name === 'woopread') {
        const catalog = flightChapterCatalog($);
        if (catalog?.length) return catalog.filter(row => typeof row.slug === 'string' && /^[\w-]+$/.test(row.slug) && Number(row.number) > 0).map((row): NovelChapterEntry => {
          const url = safeUrl(`${series.replace(/\/$/, '')}/${row.slug}`);
          return { number: Number(row.number), title: clean(String(row.title || '')), volume: null, sources: [{ provider: site.name, chapterKey: `${site.name}:${encodeURIComponent(url)}`, providerChapterId: url, language: 'en', translator: null, releaseDate: row.publishDate || null }] };
        }).sort((a,b) => a.number - b.number);
      }
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
      if (site.kind === 'novgo') {
        const count = Number($('#list-chapter').attr('data-total-page')) || 1;
        if (count > 100) throw new Error('novgo catalog exceeds the 100-page limit.');
        for (let page = 2; page <= count; page++) queue.push(`${series}?page=${page}`);
      }
      const deadline = Date.now() + 26000;
      while (queue.length) {
        if (Date.now() > deadline) throw new Error(`${site.name} chapter catalog timed out; retry later.`);
        const batch = queue.splice(0,5).filter(url => !visited.has(url));
        await Promise.all(batch.map(async pageUrl => {
          visited.add(pageUrl); const page = loadHtml(pages.get(pageUrl) ?? await html(pageUrl, series));
          page(site.chapters).each((_,node)=>{
            const a=page(node); let url:string; try {url=safeUrl(a.attr('href') || '', pageUrl);} catch{return;}
            if (url===series || links.has(url)) return;
            if (new URL(url).search || new URL(url).hash) return;
            const label=clean(a.find('.chapter-title,.chapter-item-title').first().text() || a.attr('title') || a.text()); if(!label) return;
            if (site.kind === 'wordpress' && !new URL(url).pathname.startsWith(new URL(series).pathname)) return;
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
      const entries = values.map((row,index):NovelChapterEntry=>({number:site.kind === 'wordpress' ? index+1 : row.number ?? index+1,title:row.label,volume:null,sources:[{provider:site.name,chapterKey:`${site.name}:${encodeURIComponent(row.url)}`,providerChapterId:row.url,language:'en',translator:null,releaseDate:null}]})).filter(row=>row.number>0).sort((a,b)=>a.number-b.number);
      // Mixed catalogues label comics as "novels" too. Verify actual reader content
      // before advertising their chapters as prose to the novel reader.
      if (site.mixed && entries.length) {
        const sample = await this.getContent(entries[0].sources[0].chapterKey);
        if (!sample?.paragraphs.length) return [];
      }
      return entries;
    },
    async getContent(chapterKey):Promise<NovelContentEntry|null> {
      const prefix=`${site.name}:`;if(!chapterKey.startsWith(prefix)) throw new Error('Invalid novel chapter key');
      const url=safeUrl(decodeURIComponent(chapterKey.slice(prefix.length))); const $=loadHtml(await html(url));
      const body=$(site.content).first(); if(!body.length) return null;
      if ($('img.mangaread-manga-pic,.reading-content .page-break img,.reading-content img.wp-manga-chapter-img').length) return null;
      body.find('script,style,iframe,.ads,.advertisement,.adsbygoogle,.chapter-nav,.nav-buttons,.sharedaddy,.jp-relatedposts').remove();
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
  {name:'readnovelfull',base:'https://readnovelfull.com',search:(q:string)=>`https://readnovelfull.com/novel-list/search?keyword=${encodeURIComponent(q)}`,series:/^\/(?!search|chapter|index)[^/]+\.html\/?$/,chapters:'ul.list-chapter li a,.list-chapter a',content:'#chapter-content,.chapter-content'},
  {name:'novelcool',base:'https://www.novelcool.com',search:(q:string)=>`https://www.novelcool.com/search/?name=${encodeURIComponent(q)}`,series:/^\/novel\/[^/]+\/?$/,chapters:'.chapter-item-list .chp-item a[href*="/chapter/"],.wp-manga-chapter a,.chapter-list a',content:'.site-content > .overflow-hidden,.chapter-content,.reading-content,.chapter-reading-section,.chapter-text',kind:'madara',mixed:true},
  {name:'novgo',base:'https://novgo.net',search:(q:string)=>`https://novgo.net/search?keyword=${encodeURIComponent(q)}`,series:/^\/[^/]+\.html\/?$/,chapters:'#list-chapter a[href]',content:'#chapter-content',kind:'novgo'},
  {name:'relibrary',base:'https://re-library.com',search:()=>`https://re-library.com/translations/`,series:/^\/translations\/[^/]+\/?$/,chapters:'.entry-content a[href]',content:'.entry-content',kind:'wordpress'},
  {name:'woopread',base:'https://woopread.com',search:(q:string)=>`https://woopread.com/search?q=${encodeURIComponent(q)}`,series:/^\/series\/[^/]+\/?$/,chapters:'#chapter-list-container a[href]',content:'div[id^="chapter-"]'},
  ...[
    {name:'toonily',base:'https://toonily.com'},
    {name:'onisaga',base:'https://onisaga.com'},
    {name:'toongod',base:'https://toongod.org'},
  ].map(({name,base}) => ({name,base,search:(q:string)=>`${base}/?s=${encodeURIComponent(q)}&post_type=wp-manga`,series:/^\/(?:novel|manga|serie|series|webtoon)\/[^/]+\/?$/,chapters:'.wp-manga-chapter a',content:'.reading-content',kind:'madara',mixed:true})),
].map(site=>createHtmlNovelProvider(site as Site));
