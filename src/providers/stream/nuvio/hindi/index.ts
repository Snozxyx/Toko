/**
 * Hindi / South-Asian / multi-dub Indian streaming provider group.
 *
 * Ported from the nuvio-HindiAPI repo. Alphabetical by file name.
 *
 * Removed 2026-10 after a live-origin audit (genuine deadness, not this CI's
 * bot-block): `cinemacityhindi` (cinemacity.pro = NXDOMAIN, no dynamic
 * resolver), `cinestream` (webstreamr.hayd.uk archived — explicit shutdown
 * notice), `hindmoviez` (HF Space badboysxs/morpheus deleted → 401 + addon
 * routes 404), `movies4u` (movies4u.finance = NXDOMAIN, no resolver),
 * `moviesdrive` (moviesdrives.my = NXDOMAIN, no resolver).
 */

import { fourkhdHub }     from './4khdhub.js';
import { allmovieland }  from './allmovieland.js';
import { hdmovie2 }      from './hdmovie2.js';
import { movieblast }    from './movieblast.js';
import { movieboxhindi } from './moviebox.js';
import { netmirror }     from './netmirror.js';
import { streamflix }    from './streamflix.js';
import { vegamovies }    from './vegamovies.js';

export const HINDI_PROVIDERS = [
  fourkhdHub,
  allmovieland,
  hdmovie2,
  movieblast,
  movieboxhindi,
  netmirror,
  streamflix,
  vegamovies,
];

export {
  fourkhdHub,
  allmovieland,
  hdmovie2,
  movieblast,
  movieboxhindi,
  netmirror,
  streamflix,
  vegamovies,
};
