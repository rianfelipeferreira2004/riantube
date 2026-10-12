// Cliente singleton do Innertube (youtubei.js)
// Evita recriar sessão a cada request (lento e pode levar a bloqueio).

import { Innertube } from 'youtubei.js';

let innertubePromise = null;

export async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      lang: process.env.YT_LANG || 'pt',
      location: process.env.YT_LOCATION || 'BR',
    }).catch((err) => {
      // Permite retry na próxima chamada
      innertubePromise = null;
      throw err;
    });
  }
  return innertubePromise;
}
