/** Manta chapter novels; comics and volume editions are separate products. */
import type { NovelProvider } from '../../types/index.js';
import { fetchJson } from '../../utils/http/fetch.js';
import { readPublicNovelText } from '../../utils/common/cf-bypass.js';
const BASE = 'https://manta.net';
const novelTypes = new Set([20, 40, 120]);
const readableStates = new Set([100, 110]);
const title = (row: any) => typeof row?.data?.title === 'string' ? row.data.title : row?.data?.title?.en || '';
const seriesUrl = (id: string) => `${BASE}/en/series/novel?seriesId=${id}`;
const provider: NovelProvider = {
  name: 'manta', sites: [BASE],
  async search(query) {
    const result = await fetchJson<{ data?: any[] }>(`${BASE}/manta/v1/search/series?lang=en&q=${encodeURIComponent(query)}`, { timeoutMs: 12000 });
    return (result?.data || []).filter(row => novelTypes.has(row.type) && title(row) && /^\d+$/.test(String(row.id)))
      .map(row => ({ id: String(row.id), title: title(row), url: seriesUrl(String(row.id)) }));
  },
  async getChapters(params) {
    const id = params.seriesId;
    if (!id || !/^\d+$/.test(id)) return [];
    const seriesResult = await fetchJson<{ data: any }>(`${BASE}/front/v1/series/${id}?lang=en`, { timeoutMs: 12000 });
    const series = seriesResult?.data;
    if (!novelTypes.has(series?.type)) return [];
    return (series.episodes || []).filter((episode: any) => readableStates.has(episode.lockData?.state) && /^\d+$/.test(String(episode.id)) && Number(episode.ord) > 0)
      .map((episode: any) => ({ number: Number(episode.ord), title: title(episode) || `Chapter ${episode.ord}`, volume: null,
        sources: [{ provider: 'manta', providerName: 'Manta', chapterKey: `manta:${id}|${episode.id}`,
          providerChapterId: `${id}|${episode.id}`, language: 'en', translator: null, releaseDate: episode.openAt || null }] }))
      .sort((a: any, b: any) => a.number - b.number);
  },
  async getContent(key) {
    const match = key.match(/^manta:(\d+)\|(\d+)$/);
    if (!match) return null;
    const episodeResult = await fetchJson<{ data: any }>(`${BASE}/front/v1/episodes/${match[2]}?lang=en`, { timeoutMs: 12000 });
    const episode = episodeResult?.data;
    if (String(episode?.seriesId) !== match[1] || !novelTypes.has(episode?.series?.type)) return null;
    // Check access before rendering; never click a Free Pass, membership, or purchase control.
    if (!readableStates.has(episode.lockData?.state)) throw new Error('This Manta chapter requires access on Manta. Only public free chapters are supported.');
    const paragraphs = await readPublicNovelText(seriesUrl(match[1]), `${BASE}/en/series/novel/episodes/chapter?episodeId=${match[2]}`);
    return { provider: 'manta', title: title(episode) || null, number: Number(episode.ord) || null,
      paragraphs: paragraphs.map((text, index) => ({ text, index })) };
  },
};
export default provider;
