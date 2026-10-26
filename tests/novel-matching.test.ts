import {expect,test} from 'bun:test';
import {pickBestNovelProviderCandidate,pickBestNovelCandidate} from '../src/utils/novel-title-match';
test('novel paths remain eligible and sequels cannot match earlier volumes',()=>{
 const candidates=[{href:'/novel/example-novel',name:'Example Novel'}];
 expect(pickBestNovelProviderCandidate(['Example Novel'],candidates,row=>[row.name])?.candidate).toBe(candidates[0]);
 expect(pickBestNovelCandidate(['Book Part 5'],[{id:'earlier',title:'Book Part 4'}])).toBeNull();
});
