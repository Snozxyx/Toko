/**
 * Multi-dub / English / South-Asian provider group.
 *
 * Ported from the Eclipsia Rust addon (temp/multi-clone). Alphabetical by file.
 *
 * Removed 2026-10 after a live-origin audit (genuine deadness, not this CI's
 * bot-block): `hdghartv` (hdghartv.cc "Service Closed"); `castle`
 * (api.hlowb.com responds but /search + root both 404 — API contract gone);
 * `ctgmovies` (ctgmovies.com and its API share static IP 103.109.92.178, which
 * refuses all :443 connections — decommissioned, hardcoded IP can't migrate).
 */

import { fourkHdHub }   from './4khdhub.js';
import { cinefreak }    from './cinefreak.js';
import { hdhub4u }      from './hdhub4u.js';
import { hindmovie }    from './hindmovie.js';
import { vaplayer }     from './vaplayer.js';
import { vegamoviesHC } from './vegamovies-hc.js';
import { vidking }      from './vidking.js';
import { vidup }        from './vidup.js';

export const MULTIDUB_PROVIDERS = [
  fourkHdHub,
  cinefreak,
  hdhub4u,
  hindmovie,
  vaplayer,
  vegamoviesHC,
  vidking,
  vidup,
];

export {
  fourkHdHub,
  cinefreak,
  hdhub4u,
  hindmovie,
  vaplayer,
  vegamoviesHC,
  vidking,
  vidup,
};
