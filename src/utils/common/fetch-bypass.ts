/**
 * Fetch with Cloudflare bypass.
 *
 * The escalation ladder providers get for free:
 *   1. Plain fetch, replaying a cached `cf_clearance` session for the origin if
 *      one exists. This is the steady state and costs nothing extra.
 *   2. If the answer is a challenge page, solve it once in a real browser
 *      (`cf-bypass.ts`) and use the HTML that solve already produced — the
 *      browser had to render the real page to prove the challenge passed, so
 *      re-fetching it would be a wasted round trip.
 *   3. If a later request 403s on a session that has gone stale, drop the
 *      session and re-solve once rather than failing the provider.
 *
 * `fetchTextWithBypass` keeps its original signature, so the providers already
 * calling it (aniworld, animeblkom, watchanimeworld) gain the bypass without
 * changing a line. Previously this function just forwarded to `fetchResponse`
 * and returned null on any non-OK status, which is why those providers reported
 * as permanently unavailable: a challenge page is a 403, so they saw nothing.
 */

import { fetchResponse } from '../http/fetch.js';
import {
  bypassCloudflare,
  clearSession,
  getCachedSession,
  isChallengeResponse,
} from './cf-bypass.js';

export interface FetchBypassOptions {
  /** Reuse a response already fetched by the caller. */
  response?: Response;
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: string;
  /** Skip the browser escalation and only attempt a plain (session-aware) fetch. */
  noBypass?: boolean;
  /** Budget for the browser solve, if one is needed. Default 45s. */
  bypassTimeoutMs?: number;
}

/** Merge a cached session's cookie + UA into caller headers, without clobbering. */
function applySession(
  url: string,
  headers: Record<string, string>
): Record<string, string> {
  const session = getCachedSession(url);
  if (!session) return headers;

  const merged: Record<string, string> = { ...headers };
  const hasCookie = Object.keys(merged).some((k) => k.toLowerCase() === 'cookie');
  if (!hasCookie && session.cookie) merged.Cookie = session.cookie;

  // Clearance is bound to the UA that earned it, so the session's UA must win
  // over both the caller's and the default. Sending the cookie under a different
  // UA is treated by Cloudflare as a stolen token and re-challenged.
  if (session.userAgent) merged['User-Agent'] = session.userAgent;

  return merged;
}

interface AttemptResult {
  status: number;
  body: string;
  ok: boolean;
}

async function attempt(
  url: string,
  options: FetchBypassOptions
): Promise<AttemptResult | null> {
  try {
    const response = options.response ?? await fetchResponse(url, {
      headers: applySession(url, options.headers || {}),
      timeoutMs: options.timeoutMs,
      method: options.method,
      body: options.body,
    });
    const body = await response.text().catch(() => '');
    return { status: response.status, body, ok: response.ok };
  } catch {
    return null;
  }
}

/**
 * GET `url` as text, transparently clearing a Cloudflare challenge if one is served.
 *
 * Returns null when the page is genuinely unavailable — a dead host, a real 404,
 * or a challenge that could not be solved because no browser is present.
 */
export async function fetchTextWithBypass(
  url: string,
  options: FetchBypassOptions = {}
): Promise<string | null> {
  const first = await attempt(url, options);

  // A clean success that is not a disguised challenge: done.
  if (first?.ok && !isChallengeResponse(first.status, first.body)) {
    return first.body;
  }

  const looksWalled =
    first === null || first.status === 403 || isChallengeResponse(first.status, first.body);

  if (!looksWalled) {
    // A real HTTP error (404, 500). Escalating would not help.
    return null;
  }

  if (options.noBypass) return null;

  // If we were replaying a session, it may simply have expired. Drop it so the
  // solve below starts clean instead of inheriting a rejected cookie.
  if (getCachedSession(url)) clearSession(url);

  const solved = await bypassCloudflare({
    url,
    timeout: options.bypassTimeoutMs,
    headers: options.headers,
  });

  if (!solved) return null;

  // The solve already rendered the target page — use it directly. Only fall back
  // to a fresh fetch when the browser landed somewhere unexpected (a redirect
  // chain that ended off-target), in which case the session is still valuable.
  if ((!options.method || options.method === 'GET') && solved.html && solved.finalUrl === url && !isChallengeResponse(200, solved.html)) {
    return solved.html;
  }

  const retry = await attempt(url, { ...options, response: undefined });
  if (retry?.ok && !isChallengeResponse(retry.status, retry.body)) {
    return retry.body;
  }
  return null;
}

/**
 * Same ladder as `fetchTextWithBypass`, but parsed as JSON.
 *
 * Separate from `fetchJson` because an API behind Cloudflare answers the
 * challenge in HTML, so the caller needs the bypass before the parse.
 */
export async function fetchJsonWithBypass<T = unknown>(
  url: string,
  options: FetchBypassOptions = {}
): Promise<T | null> {
  const text = await fetchTextWithBypass(url, {
    ...options,
    headers: { Accept: 'application/json, text/plain, */*', ...(options.headers || {}) },
  });
  if (!text) return null;

  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return JSON.parse(trimmed) as T;
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(trimmed.substring(first, last + 1)) as T;
    }
  } catch {
    /* fall through */
  }
  return null;
}
