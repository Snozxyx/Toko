/**
 * Cloudflare bypass — real implementation backed by puppeteer-real-browser.
 *
 * Why a browser at all: a managed Cloudflare challenge is a JS program. It reads
 * navigator properties, canvas/WebGL fingerprints and TLS characteristics, then
 * POSTs a proof back to `/cdn-cgi/challenge-platform/...`. There is no header set
 * a plain `fetch` can send that produces that proof, which is why the previous
 * stub could only ever return null and why AnimeBLkom/AniWorld reported as
 * "domain returns a Cloudflare challenge page to the server-side scraper".
 *
 * The expensive part is solving the challenge, not using the result. Once solved,
 * Cloudflare hands back a `cf_clearance` cookie that is accepted on ordinary
 * requests — but *only* when replayed with the same User-Agent and from the same
 * IP that earned it. So this module solves once per origin, caches the cookie +
 * UA together as a session, and lets `fetch-bypass.ts` replay them cheaply. A
 * site is browser-driven on first contact and plain-fetch thereafter.
 *
 * Everything here degrades to `null` rather than throwing. Chrome may be absent,
 * the dependency may not be installed, and the extension also runs inside a
 * worker sandbox with no child_process at all. A provider that cannot bypass
 * must return no sources — it must never take down the run.
 */

import { ensureBrowserRuntime } from './browser-runtime-bootstrap.js';

interface ProviderBrowser {
  navigate(url: string): Promise<unknown>;
  evaluate(expression: string): Promise<any>;
  executeCDP(method: string, params: unknown): Promise<any>;
  sleep(ms: number): Promise<unknown>;
  close(): Promise<unknown>;
}
interface BrowserRuntime { newBrowser(options: { headless: boolean; timeout: number }): Promise<ProviderBrowser>; }
declare const __tatakai_chromedp__: BrowserRuntime | undefined;
let browserRuntime: BrowserRuntime | undefined;
export function setCloudflareBrowserRuntime(runtime?: BrowserRuntime): void { browserRuntime = runtime; }
function getBrowserRuntime(): BrowserRuntime | undefined {
  return browserRuntime ?? (typeof __tatakai_chromedp__ !== 'undefined' ? __tatakai_chromedp__ : undefined);
}

// The desktop host already owns a permitted Electron browser. Portable .kai
// bundles cannot resolve puppeteer from the temporary directory they load in.
async function solveWithHostBrowser(options: CloudflareBypassOptions, runtime: BrowserRuntime): Promise<CloudflareBypassResult | null> {
  let browser: ProviderBrowser | undefined;
  try {
    browser = await runtime.newBrowser({ headless: true, timeout: Math.ceil((options.timeout ?? 15000) / 1000) });
    await browser.navigate(options.url);
    const deadline = Date.now() + (options.timeout ?? 15000);
    while (Date.now() < deadline) {
      const page = await browser.evaluate('({html:document.documentElement.outerHTML,url:location.href,ua:navigator.userAgent})');
      if (page?.html && !isChallengeResponse(200, page.html)) {
        if (new URL(page.url).origin !== new URL(options.url).origin) return null;
        const { cookies } = await browser.executeCDP('Network.getCookies', { urls: [options.url] });
        const session: CloudflareSession = { origin: originOf(options.url), cookie: (cookies || []).map((c: any) => `${c.name}=${c.value}`).join('; '), userAgent: page.ua, expiresAt: Date.now() + SESSION_TTL_MS };
        storeSession(session);
        return { html: page.html, finalUrl: page.url, session };
      }
      await browser.sleep(500);
    }
  } catch { /* Report an unavailable provider without breaking the fan-out. */ }
  finally { try { await browser?.close(); } catch {} }
  return null;
}

export interface CloudflareBypassOptions {
  url: string;
  /** Overall budget for solving the challenge. Default 45s. */
  timeout?: number;
  /** Extra headers to apply to the navigation. */
  headers?: Record<string, string>;
  /** Force a fresh solve, ignoring any cached session for the origin. */
  forceRefresh?: boolean;
}

/** A solved challenge: everything needed to replay it on a plain fetch. */
export interface CloudflareSession {
  origin: string;
  /** Serialized `Cookie:` header value, including cf_clearance. */
  cookie: string;
  /**
   * The UA the challenge was solved with. Cloudflare binds clearance to it, so
   * replaying the cookie under a different UA invalidates it — this must travel
   * with the cookie, never be substituted for a default.
   */
  userAgent: string;
  expiresAt: number;
}

export interface CloudflareBypassResult {
  html: string;
  session: CloudflareSession;
  finalUrl: string;
}

/** cf_clearance is good for ~30min in practice; expire early to avoid races. */
const SESSION_TTL_MS = 20 * 60 * 1000;
const DEFAULT_SOLVE_TIMEOUT_MS = 45_000;

const BYPASS_ENABLED =
  String(process.env.CF_BYPASS_ENABLED || 'true').toLowerCase() !== 'false';
const HEADLESS =
  String(process.env.CF_BYPASS_HEADLESS || 'true').toLowerCase() !== 'false';

/**
 * Body/status signatures of an unsolved challenge.
 *
 * Matched against the *response we got*, so it has to tolerate all three shapes
 * Cloudflare serves: the interstitial ("Just a moment"), the managed challenge
 * (`cf_chl_opt`), and a hard 1020 block page. Kept deliberately narrow — a false
 * positive here spends 45s of browser time on a page that was already fine.
 */
const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'cf_chl_opt',
  '__cf_chl_',
  'challenge-platform',
  'cf-challenge-running',
  'turnstile',
  'just a moment',
  'checking your browser',
  'enable javascript and cookies to continue',
  'attention required! | cloudflare',
  'ddos-guard',
];

/**
 * Does this response look like an unsolved bot wall?
 *
 * Status alone is not enough: plenty of sites 403 a bad path, and Cloudflare
 * serves challenges with 200 as often as 503. So a challenge is either a
 * CF-flavoured status *with* a marker in the body, or an unmistakable marker
 * regardless of status.
 */
export function isChallengeResponse(status: number, body: string): boolean {
  const haystack = (body || '').slice(0, 6000).toLowerCase();
  if (!haystack) return status === 403 || status === 503;

  const hasMarker = CHALLENGE_MARKERS.some((m) => haystack.includes(m));
  if (hasMarker) return true;

  // A CF-fronted error with a tiny body is almost always a wall, not content.
  if ((status === 403 || status === 503 || status === 429) && haystack.length < 2000) {
    return haystack.includes('cloudflare') || haystack.includes('cf-ray');
  }
  return false;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// ── Session cache ────────────────────────────────────────────────────────────

const sessions = new Map<string, CloudflareSession>();

/** In-flight solves, keyed by origin, so N providers hitting one site solve once. */
const inflight = new Map<string, Promise<CloudflareBypassResult | null>>();

/** Origins that failed to solve, with a cooldown so we stop paying 45s each. */
const failures = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

export function getCachedSession(url: string): CloudflareSession | null {
  const origin = originOf(url);
  const hit = sessions.get(origin);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    sessions.delete(origin);
    return null;
  }
  return hit;
}

export function storeSession(session: CloudflareSession): void {
  sessions.set(session.origin, session);
}

export function clearSession(url: string): void {
  sessions.delete(originOf(url));
}

function isCoolingDown(origin: string): boolean {
  const until = failures.get(origin);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    failures.delete(origin);
    return false;
  }
  return true;
}

// ── puppeteer-real-browser loading ───────────────────────────────────────────

type ConnectFn = (opts: Record<string, unknown>) => Promise<{
  browser: any;
  page: any;
}>;

let connectFn: ConnectFn | null | undefined;

/**
 * Resolve `puppeteer-real-browser` at runtime.
 *
 * Deliberately not a static import. The build inlines every non-builtin
 * dependency into a single portable bundle, and puppeteer drags in native
 * bindings and dynamic requires that cannot survive that. Loading it through an
 * indirect `require`/`import` keeps it out of the dependency graph esbuild
 * walks, so the bundle still runs in the worker sandbox where the package — and
 * `child_process` itself — simply does not exist.
 */
async function loadConnect(): Promise<ConnectFn | null> {
  if (connectFn !== undefined) return connectFn;
  connectFn = null;

  const moduleName = 'puppeteer-real-browser';
  try {
    // Indirect require: invisible to esbuild's static analysis.
    const req = (
      globalThis as unknown as { require?: (id: string) => any }
    ).require;
    if (typeof req === 'function') {
      const mod = req(moduleName);
      if (typeof mod?.connect === 'function') connectFn = mod.connect;
    }
  } catch {
    /* fall through to dynamic import */
  }

  if (!connectFn) {
    try {
      // Concatenated specifier so esbuild cannot resolve it at build time.
      const mod: any = await import(/* @vite-ignore */ moduleName + '');
      const candidate = mod?.connect ?? mod?.default?.connect;
      if (typeof candidate === 'function') connectFn = candidate;
    } catch {
      connectFn = null;
    }
  }

  return connectFn ?? null;
}

/** True when a real browser could plausibly be launched in this environment. */
export async function isBypassAvailable(): Promise<boolean> {
  if (!BYPASS_ENABLED) return false;
  if (getBrowserRuntime()) return true;
  const connect = await loadConnect();
  if (!connect) return false;
  try {
    const { chromePath } = ensureBrowserRuntime();
    return Boolean(chromePath);
  } catch {
    return false;
  }
}

// ── Solving ──────────────────────────────────────────────────────────────────

/**
 * Drive a real browser until the challenge clears, then harvest the session.
 *
 * `puppeteer-real-browser` is used rather than plain puppeteer because it ships
 * the patches that matter: a non-headless-looking Chrome, a real window, and
 * automatic Turnstile clicking. Stock puppeteer is detected immediately.
 */
async function solveChallenge(
  options: CloudflareBypassOptions
): Promise<CloudflareBypassResult | null> {
  const connect = await loadConnect();
  if (!connect) return null;

  const { chromePath, hasXvfb } = ensureBrowserRuntime();
  if (!chromePath) return null;

  const timeout = options.timeout ?? DEFAULT_SOLVE_TIMEOUT_MS;
  const origin = originOf(options.url);

  let browser: any = null;
  let page: any = null;

  try {
    const connection = await connect({
      headless: HEADLESS,
      customConfig: { chromePath },
      turnstile: true,
      connectOption: { defaultViewport: null },
      disableXvfb: !hasXvfb,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    browser = connection.browser;
    page = connection.page;

    if (options.headers && Object.keys(options.headers).length > 0) {
      // Drop headers the browser must own itself — overriding UA here would
      // desync it from the fingerprint the challenge measures, and Cookie is
      // managed by the jar we are about to read.
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.headers)) {
        const key = k.toLowerCase();
        if (key === 'user-agent' || key === 'cookie' || key === 'host') continue;
        safe[k] = v;
      }
      if (Object.keys(safe).length > 0) {
        try {
          await page.setExtraHTTPHeaders(safe);
        } catch {
          /* non-fatal */
        }
      }
    }

    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout });

    // Wait for the interstitial to go away rather than for a fixed delay: the
    // challenge replaces the document once it passes, so poll the body for the
    // markers instead of guessing how long the proof-of-work will take.
    const deadline = Date.now() + timeout;
    let html = '';
    while (Date.now() < deadline) {
      html = await page.content().catch(() => '');
      if (html && !isChallengeResponse(200, html)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!html) return null;

    // Still walled after the full budget — report failure so the caller can
    // fall back rather than treat the challenge page as scrapeable content.
    if (isChallengeResponse(200, html)) return null;

    const rawCookies: Array<{ name: string; value: string }> =
      (await page.cookies().catch(() => [])) || [];
    const cookie = rawCookies
      .filter((c) => c && c.name)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const userAgent: string = await page
      .evaluate(() => navigator.userAgent)
      .catch(() => '');

    const finalUrl: string = (await page.url?.().catch?.(() => options.url)) || options.url;

    const session: CloudflareSession = {
      origin,
      cookie,
      userAgent: userAgent || '',
      expiresAt: Date.now() + SESSION_TTL_MS,
    };

    // Only cache a session that carries real clearance. Caching a cookie-less
    // session would make every later request look "already solved" and fail.
    if (cookie.includes('cf_clearance') || cookie.length > 0) {
      storeSession(session);
    }

    return { html, session, finalUrl };
  } catch {
    return null;
  } finally {
    try {
      await page?.close?.();
    } catch {
      /* ignore */
    }
    try {
      await browser?.close?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Solve a Cloudflare challenge for `url` and return the page plus its session.
 *
 * Concurrent callers for the same origin share one solve: a page's worth of
 * providers commonly target the same site at once, and launching a browser per
 * caller would be both slow and more detectable.
 */
export async function bypassCloudflare(
  options: CloudflareBypassOptions
): Promise<CloudflareBypassResult | null> {
  if (!BYPASS_ENABLED) return null;

  const origin = originOf(options.url);
  if (!options.forceRefresh && isCoolingDown(origin)) return null;

  const existing = inflight.get(origin);
  if (existing && !options.forceRefresh) return existing;

  const task = (async () => {
    const runtime = getBrowserRuntime();
    const result = runtime ? await solveWithHostBrowser(options, runtime) : await solveChallenge(options);
    if (!result) failures.set(origin, Date.now() + FAILURE_COOLDOWN_MS);
    else failures.delete(origin);
    return result;
  })().finally(() => {
    inflight.delete(origin);
  });

  inflight.set(origin, task);
  return task;
}

/**
 * Obtain a replayable session for `url` without caring about the page body.
 *
 * This is the entry point providers should use when they only need clearance
 * for subsequent plain fetches — it reuses a cached session when one is live and
 * only pays for a browser when there is nothing to reuse.
 */
export async function getCloudflareSession(
  url: string,
  options?: Omit<CloudflareBypassOptions, 'url'>
): Promise<CloudflareSession | null> {
  if (!options?.forceRefresh) {
    const cached = getCachedSession(url);
    if (cached) return cached;
  }
  const solved = await bypassCloudflare({ url, ...options });
  return solved?.session ?? null;
}
