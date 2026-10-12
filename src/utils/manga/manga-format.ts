import type { TokoCheerio } from "../http/fetch.js";

export function isNovelFormat(value: unknown): boolean {
  const format = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[\s_-]+/g, "");
  return [
    "novel",
    "lightnovel",
    "webnovel",
    "ln",
    "wn",
    "prose",
    "textnovel",
  ].includes(format);
}

/** Format markers are checked before fuzzy normalization can erase them. */
export function isNovelMangaCandidate(
  candidate: unknown,
  names: string[]
): boolean {
  const record = (
    candidate && typeof candidate === "object" ? candidate : {}
  ) as Record<string, unknown>;
  if (record.isNovel === true || record.is_novel === true) return true;
  const formats = [
    record.format,
    record.type,
    record.medium,
    record.mediaType,
    record.contentType,
  ];
  if (formats.some(isNovelFormat)) return true;
  if (
    names.some(
      (name) =>
        /[([]\s*(?:novel|light[\s-]*novel|web[\s-]*novel|ln|wn)\s*[)\]]\s*$/i.test(
          name
        ) ||
        /^\s*[([]\s*(?:novel|light[\s-]*novel|web[\s-]*novel|ln|wn)\s*[)\]]/i.test(
          name
        ) ||
        /\s[-–:]\s*(?:novel|light[\s-]*novel|web[\s-]*novel)\s*$/i.test(name)
    )
  )
    return true;
  const knownComic = formats.some((value) =>
    ["comic", "manga", "manhwa", "manhua", "webtoon"].includes(
      String(value || "").toLowerCase()
    )
  );
  if (knownComic) return false;
  const path = String(record.href || record.url || "").split(/[?#]/)[0];
  // NovelCool uses /novel/ for both formats and must verify actual panels.
  const novelCool = /novelcool\.com/i.test(path);
  return (
    (!novelCool && /\/novels?\//i.test(path)) ||
    /-(?:light-|web-)?novel(?:\.html)?\/?$/i.test(path)
  );
}

/** Read explicit format labels on a series page, not genre/description keywords. */
export function hasNovelSeriesMetadata($: TokoCheerio): boolean {
  let novel = false;
  $(
    ".post-content_item, .summary-content-item, [data-content-type], [data-medium]"
  ).each((_, el) => {
    const item = $(el);
    if (
      isNovelFormat(item.attr("data-content-type")) ||
      isNovelFormat(item.attr("data-medium"))
    )
      novel = true;
    const label = item
      .find(".summary-heading, .label, dt")
      .first()
      .text()
      .trim()
      .replace(/:$/, "")
      .trim()
      .toLowerCase();
    if (
      ["type", "format", "medium"].includes(label) &&
      isNovelFormat(item.find(".summary-content, .value, dd").first().text())
    )
      novel = true;
  });
  return novel;
}
