/**
 * Direct Cloudflare-bypass probe. Confirms whether a real browser can launch and
 * clear a challenge in THIS environment, isolating "browser works" from
 * "provider logic works". Run: npx tsx scripts/cf-probe.ts <url>
 */
import { bypassCloudflare, isBypassAvailable } from '../src/utils/common/cf-bypass.js';

async function main() {
  const url = process.argv[2] || 'https://aniworld.to/';
  console.log('isBypassAvailable:', await isBypassAvailable());
  const t = Date.now();
  const r = await bypassCloudflare({ url, timeout: 60_000 });
  const dt = ((Date.now() - t) / 1000).toFixed(1);
  if (!r) {
    console.log(`RESULT null after ${dt}s — browser could not launch or solve.`);
  } else {
    const hasClearance = r.session.cookie.includes('cf_clearance');
    console.log(`RESULT ok after ${dt}s`);
    console.log('  finalUrl   :', r.finalUrl);
    console.log('  htmlLen    :', r.html.length);
    console.log('  cf_clearance:', hasClearance);
    console.log('  cookieKeys :', r.session.cookie.split('; ').map((c) => c.split('=')[0]).join(','));
    console.log('  ua         :', r.session.userAgent.slice(0, 60));
    console.log('  htmlHead   :', r.html.replace(/\s+/g, ' ').slice(0, 200));
  }
  setTimeout(() => process.exit(0), 300);
}
main();
