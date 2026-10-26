import {expect,test} from 'bun:test';
import {normalizeNovelParagraphs} from '../src/utils/novel-text';
test('novel payloads contain ordered prose, not image files or objects',()=>{
 expect(normalizeNovelParagraphs([{index:9,text:'<p>A chapter <em>begins</em>.</p>'},{url:'https://example.org/page.png'},'https://example.org/page.jpg','<img src="page.jpg">','<script>bad()</script><p>Next paragraph.</p>'])).toEqual([{index:0,text:'A chapter begins.'},{index:1,text:'Next paragraph.'}]);
});
