/**
 * DivineDaoLibrary — https://www.divinedaolibrary.com
 *
 * Translator site on the Fictioneer WordPress theme (server-rendered):
 *   - search   → `/?s=<query>`; story cards are
 *                `a.card__link-list-link[href^="/story/"]`. Story URLs are
 *                single-segment (`/story/<slug>/`); chapter URLs carry two
 *                segments and are filtered out here.
 *   - chapters → story page `/story/<slug>/` lists the FULL catalog,
 *                volume-grouped: `.chapter-group` → heading holds
 *                `Volume N`, rows are
 *                `a.chapter-group__list-item-link[href]` ("Chapter 1, Title")
 *                with dates in `time`. Fallback is the JSON-LD `ItemList`
 *                (`"position":N,"url":"…"`) when the theme markup drifts.
 *   - content  → chapter page body `#chapter-content p`
 *                (fallback `.chapter__content p`); title `h1.chapter__title`.
 *
 * No AniList id on-page — fuzzy title match via the shared resolver.
 * best-effort: every step degrades to []/null so the reader falls back to
 * the next provider.
 */
import type {
  NovelProvider,
  NovelChapterEntry,
  NovelChapterParams,
  NovelChapterSource,
  NovelContentEntry,
} from '../../types/index.js';

import { fetchText, loadHtml } from '../../utils/http/fetch.js';
import { fetchNovelSearchHtml } from './novel-http.js';
import { resolveMangaTitles, pickBestMangaCandidate } from '../../utils/manga/manga-title-resolver.js';

const BASE = 'https://www.divinedaolibrary.com';
const PROVIDER_NAME = 'divinedaolibrary';

interface DdlCandidate {
  href: string;
  name: string;
}

function toUrl(href: string): string {
  return href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

async function searchSeries(query: string): Promise<DdlCandidate[]> {
  const html = await fetchNovelSearchHtml(`${BASE}/?s=${encodeURIComponent(query)}`);
  if (!html) return [];
  const $ = loadHtml(html);
  const byHref = new Map<string, DdlCandidate>();
  $('a.card__link-list-link[href]').each((_, el) => {
    const a = $(el);
    const href = (a.attr('href') || '').trim();
    let path = '';
    try {
      path = new URL(toUrl(href)).pathname;
    } catch {
      return;
    }
    // Stories are single-segment (/story/<slug>/); two-segment links are
    // individual chapters, not series.
    if (!/^\/story\/[^/]+\/$/.test(path)) return;
    const name = (a.attr('title') || a.text()).trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || byHref.has(path)) return;
    byHref.set(path, { href: path, name });
  });
  return Array.from(byHref.values()).slice(0, 20);
}

async function resolveSeriesHref(params: NovelChapterParams): Promise<string | null> {
  const titles = await resolveMangaTitles(params);
  if (titles.length === 0) return null;
  const pool: DdlCandidate[] = [];
  const seen = new Set<string>();
  for (const title of titles.slice(0, 2)) {
    let cands: DdlCandidate[] = [];
    try {
      cands = await searchSeries(title);
    } catch {
      continue;
    }
    for (const cand of cands) {
      if (seen.has(cand.href)) continue;
      seen.add(cand.href);
      pool.push(cand);
    }
  }
  const best = pickBestMangaCandidate(titles, pool, (c) => [c.name], 0.6);
  return best ? best.candidate.href : null;
}

function parseChapterNumber(label: string, href: string): number {
  let m = label.match(/chapter\s+(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = href.match(/-chapter-(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

function cleanTitle(label: string): string {
  const m = label.match(/^chapter\s+[\d.]+\s*,\s*(.+)$/i);
  return (m ? m[1] : label).trim() || label;
}

async function getChapters(params: NovelChapterParams): Promise<NovelChapterEntry[]> {
  try {
    const href = params.seriesId || await resolveSeriesHref(params);
    if (!href) return [];
    const url = toUrl(href);
    if (new URL(url).origin !== BASE || !/^\/story\/[^/]+\/$/.test(new URL(url).pathname)) {
      throw new Error('Invalid DivineDaoLibrary title URL');
    }
    const html = await fetchText(url, { timeoutMs: 15000 });
    if (!html) return [];
    const $ = loadHtml(html);
    const byNumber = new Map<number, NovelChapterEntry>();
    const push = (
      full: string,
      label: string,
      date: string | null,
    ): void => {
      if (!full.startsWith(`${BASE}/story/`)) return;
      const num = parseChapterNumber(label, full);
      if (!Number.isFinite(num) || num <= 0 || byNumber.has(num)) return;
      const source: NovelChapterSource = {
        provider: PROVIDER_NAME,
        chapterKey: `${PROVIDER_NAME}:${encodeURIComponent(full)}`,
        providerChapterId: full,
        language: 'en',
        translator: null,
        releaseDate: date,
      };
      byNumber.set(num, { number: num, title: cleanTitle(label), volume: null, sources: [source] });
    };
    // Primary: the volume-grouped server-rendered catalog (full list +
    // titles + dates). Volume groups are separate `.chapter-group` blocks
    // whose heading names the volume; chapters inherit it.
    $('.chapter-group').each((_, g) => {
      const group = $(g);
      group.find('a.chapter-group__list-item-link[href]').each((__, el) => {
        const a = $(el);
        const chHref = (a.attr('href') || '').trim();
        if (!chHref) return;
        const full = toUrl(chHref);
        const label = (a.attr('title') || a.text()).trim().replace(/\s+/g, ' ');
        if (!label) return;
        const time = a.closest('li').find('time').first();
        const stamp = time.attr('datetime');
        const date = stamp && Number.isFinite(Number(stamp))
          ? new Date(Number(stamp) * 1000).toISOString()
          : time.text().trim() || null;
        push(full, label, date);
      });
    });
    // Fallback: JSON-LD ItemList positions (number + URL; titles derived
    // from the chapter slug) when the theme markup drifts.
    if (byNumber.size === 0) {
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      const re = /"position":(\d+),"url":"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const full = m[2].replace(/\\\//g, '/');
        if (!full.startsWith(`${BASE}/story/`)) continue;
        const tail = full.split('/').filter(Boolean).pop() || '';
        const title = tail
          .replace(new RegExp(`^${slug}-chapter-[\\d.]+-?`, 'i'), '')
          .replace(/-/g, ' ')
          .trim();
        push(full, `Chapter ${m[1]}${title ? `, ${title}` : ''}`, null);
      }
    }
    return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
  } catch {
    return [];
  }
}

function extractParagraphs($: ReturnType<typeof loadHtml>): string[] {
  const out: string[] = [];
  const nodes = $('#chapter-content p');
  const list = nodes.length > 0 ? nodes : $('.chapter__content p');
  list.each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text) return;
    // Translator/editor credit lines, not story text.
    if (/^(translator|translation|editor|proofreader)\s*:/i.test(text) && text.length < 120) return;
    out.push(text);
  });
  return out;
}

const provider: NovelProvider = {
  name: PROVIDER_NAME,
  sites: [BASE],
  async search(query) {
    return (await searchSeries(query)).map((row) => ({ id: row.href, title: row.name, url: toUrl(row.href) }));
  },

  getChapters,

  async getContent(chapterKey: string): Promise<NovelContentEntry | null> {
    try {
      const prefix = `${PROVIDER_NAME}:`;
      if (!chapterKey.startsWith(prefix)) return null;
      const url = decodeURIComponent(chapterKey.slice(prefix.length));
      if (!url.startsWith(BASE) || !/\/story\/[^/]+\/[^/]+\//.test(new URL(url).pathname)) return null;
      const html = await fetchText(url, { timeoutMs: 15000 });
      if (!html) return null;
      const $ = loadHtml(html);
      const title = $('h1.chapter__title').first().text().trim() || null;
      const texts = extractParagraphs($);
      if (texts.length === 0) return null;
      return {
        title,
        number: null,
        paragraphs: texts.map((text, index) => ({ index, text })),
        provider: PROVIDER_NAME,
      };
    } catch {
      return null;
    }
  },
};

export default provider;
