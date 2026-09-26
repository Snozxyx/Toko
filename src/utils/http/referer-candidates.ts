/**
 * Stream referer candidates
 *
 * Which `Referer` a given streaming CDN expects is knowledge the *extension*
 * owns — not the app's proxy. The core Tatakai proxy is content-agnostic and
 * simply forwards whatever referer(s) the caller passes. This module reproduces
 * the per-host referer mapping the extension needs so it can ship an ordered
 * candidate list on every direct-stream result (`SourceResult.refererCandidates`).
 *
 * The list is best-first and always begins with the provider's own primary
 * referer (when supplied), followed by known-good alternates for that CDN
 * family, and finally the stream's own origin as a last resort.
 */

function normalizeReferer(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(String(value)).href;
  } catch {
    return '';
  }
}

function getHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Per-CDN referer alternates. Keyed by a substring match on the stream host.
 * These mirror the host→referer pairs the providers already rely on so the app
 * can retry the right site when the primary referer is momentarily rejected.
 */
function alternatesForHost(host: string): string[] {
  if (!host) return [];

  // AnimePahe → kwik / owocdn CDNs
  if (
    host.includes('kwik') ||
    host.includes('kwics') ||
    host.includes('owocdn')
  ) {
    return [
      'https://animepahe.com/',
      'https://animepahe.ru/',
      'https://kwik.cx/',
      'https://kwik.si/',
    ];
  }

  // AnimeKai → megaup / shop21pro CDNs
  if (host.includes('megaup') || host.includes('shop21pro')) {
    return ['https://animekai.to/', 'https://animekai.bz/'];
  }

  // HiAnime / megacloud family
  if (
    host.includes('megacloud') ||
    host.includes('rabbitstream') ||
    host.includes('dokicloud')
  ) {
    return [
      'https://megacloud.blog/',
      'https://hianime.to/',
      'https://aniwatchtv.to/',
    ];
  }

  // Some embeds proxy through watching.onl and expect the megacloud family.
  if (host.includes('watching.onl')) {
    return [
      'https://rabbitstream.net/',
      'https://dokicloud.one/',
      'https://hianime.to/',
      'https://aniwatchtv.to/',
    ];
  }

  return [];
}

/**
 * Build the ordered, deduped referer candidate list for a stream URL.
 * @param streamUrl     the direct playback URL (HLS manifest / mp4)
 * @param primaryReferer the provider's own `headers.Referer`, if any
 */
export function buildStreamRefererCandidates(
  streamUrl: string,
  primaryReferer?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined) => {
    const normalized = normalizeReferer(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  // 1. The provider's own referer always wins.
  add(primaryReferer);

  const host = getHost(streamUrl);

  // 2. Known-good alternates for this CDN family.
  alternatesForHost(host).forEach(add);

  // 3. The stream's own origin, for hosts that reject foreign referers.
  try {
    add(`${new URL(streamUrl).origin}/`);
  } catch {
    // Ignore malformed URL.
  }

  return out;
}
