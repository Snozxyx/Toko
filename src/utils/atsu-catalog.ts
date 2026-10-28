import { fetchJson } from './http/fetch.js';

export interface AtsuChapter {
  id: string; number: number; title?: string | null; createdAt?: number | null;
  scanlationMangaId?: string; language?: string;
}
interface Scanlator { id: string; name: string; language?: string }
const catalogs = new Map<string, { at: number; value: Promise<{ chapters: AtsuChapter[]; scanlators: Scanlator[] }> }>();

export function atsuBaseProvider(name: string | undefined): string | undefined {
  return name?.match(/^(atsu(?:-novel)?)@[\w-]+$/)?.[1] || name;
}

export async function getAtsuCatalog(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid Atsu series id');
  const hit = catalogs.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = Promise.all([
    fetchJson<{ chapters?: AtsuChapter[] }>(`https://atsu.moe/api/manga/allChapters?mangaId=${encodeURIComponent(id)}`, { timeoutMs: 12000 }),
    fetchJson<{ mangaPage?: { scanlators?: Scanlator[] } }>(`https://atsu.moe/api/manga/page?id=${encodeURIComponent(id)}`, { timeoutMs: 8000 }).catch(() => null),
  ]).then(([chapters, page]) => ({ chapters: chapters?.chapters || [], scanlators: page?.mangaPage?.scanlators || [] }));
  if (catalogs.size >= 40) catalogs.delete(catalogs.keys().next().value!);
  catalogs.set(id, { at: Date.now(), value });
  void value.catch(() => catalogs.delete(id));
  return value;
}

/** One stable source per upstream. Chapter numbers shared by different groups are alternatives. */
export function atsuSource(base: 'atsu' | 'atsu-novel', seriesId: string, chapter: AtsuChapter, scanlators: Scanlator[]) {
  const groupId = chapter.scanlationMangaId;
  const group = scanlators.find(row => row.id === groupId);
  const provider = groupId && /^[\w-]+$/.test(groupId) ? `${base}@${groupId}` : base;
  const name = group?.name || groupId || null;
  return {
    provider, providerName: name ? `Atsu · ${name}` : 'Atsu',
    chapterKey: `${provider}:${seriesId}|${chapter.id}`,
    providerChapterId: chapter.id, language: chapter.language || group?.language || 'en',
    releaseDate: chapter.createdAt && Number.isFinite(new Date(chapter.createdAt).getTime()) ? new Date(chapter.createdAt).toISOString() : null,
    scanlator: name, translator: name,
  };
}
