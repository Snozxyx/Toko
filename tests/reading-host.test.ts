import {expect,test} from 'bun:test';
import {TokoBundleClass} from '../src/core/bundle';
import {NOVEL_PROVIDERS} from '../src/providers/registry';

test('hosted novel calls include later prose providers before the worker exits',async()=>{
 const saved=NOVEL_PROVIDERS.map(p=>({p,search:p.search,getChapters:p.getChapters}));
 const chapter=(provider:string,number:number)=>({number,title:null,volume:null,sources:[{provider,chapterKey:`${provider}:${number}`,providerChapterId:String(number),language:'en',translator:null,releaseDate:null}]});
 for(const p of NOVEL_PROVIDERS){p.search=async query=>[{id:'fixture',title:query}];p.getChapters=async()=>[];}
 NOVEL_PROVIDERS[0].getChapters=async()=>[chapter(NOVEL_PROVIDERS[0].name,1)];
 NOVEL_PROVIDERS[1].getChapters=async()=>{await new Promise(resolve=>setTimeout(resolve,30));return [chapter(NOVEL_PROVIDERS[1].name,2)];};
 try {expect((await new TokoBundleClass().getNovelChapters({title:'Fixture',titles:['Fixture']})).map(row=>row.number)).toEqual([1,2]);}
 finally{for(const entry of saved){entry.p.search=entry.search;entry.p.getChapters=entry.getChapters;}}
});
