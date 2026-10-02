/**
 * Latin American / Spanish-language provider group.
 *
 * Ported from the nuvio-Latino repo. Alphabetical by file name.
 *
 * Removed 2026-10 after a live-origin audit (genuine deadness, not this CI's
 * bot-block): `brazucaplay` (sole data endpoint api2.videasy.net = NXDOMAIN),
 * `cuevanaUnbuendato` (cuevana.unbuendato.com = NXDOMAIN), `pelisplus`
 * (pelisplus.icu = NXDOMAIN), `playhubmax` (both site + api hosts = NXDOMAIN).
 */

import { cinemacity }         from './cinemacity.js';
import { cinecalidad }        from './cinecalidad.js';
import { embed69 }            from './embed69.js';
import { fuegocine }          from './fuegocine.js';
import { hackstore2 }         from './hackstore2.js';
import { lamovie }            from './lamovie.js';
import { pelisgo }            from './pelisgo.js';
import { pelispanda }         from './pelispanda.js';
import { pelispedia }         from './pelispedia.js';
import { seriesmetro }        from './seriesmetro.js';
import { sololatino }         from './sololatino.js';
import { tioplus }            from './tioplus.js';
import { videasy }            from './videasy.js';
import { xupalace }           from './xupalace.js';

export const LATINO_PROVIDERS = [
  cinemacity,
  cinecalidad,
  embed69,
  fuegocine,
  hackstore2,
  lamovie,
  pelisgo,
  pelispanda,
  pelispedia,
  seriesmetro,
  sololatino,
  tioplus,
  videasy,
  xupalace,
];

export {
  cinemacity,
  cinecalidad,
  embed69,
  fuegocine,
  hackstore2,
  lamovie,
  pelisgo,
  pelispanda,
  pelispedia,
  seriesmetro,
  sololatino,
  tioplus,
  videasy,
  xupalace,
};
