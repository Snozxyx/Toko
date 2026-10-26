import { loadHtml } from './http/fetch.js';

/** The novel reader consumes prose, never image URLs or provider objects. */
export function normalizeNovelParagraphs(values: unknown): { index: number; text: string }[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap(value => {
    let text = typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.text === 'string' ? value.text : '';
    if (/<[a-z][^>]*>/i.test(text)) {
      const $ = loadHtml(text); $('script,style,img,iframe,video,audio,svg').remove(); text = $.text();
    }
    text = text.trim();
    if (!text || /^(?:https?:\/\/|data:image\/|blob:)/i.test(text)) return [];
    return [text];
  }).map((text,index) => ({text,index}));
}
