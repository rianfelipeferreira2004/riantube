// Cliente singleton do Innertube (youtubei.js)
// Evita recriar sessão a cada request (lento e pode levar a bloqueio).
// Suporta múltiplos clients (WEB padrão + fallbacks) e cookie opcional via env.
// YT_COOKIE: cookie de uma conta/sessão do YouTube (reduz bloqueios do datacenter).

import { Innertube } from 'youtubei.js';

const sessions = new Map();

export async function getInnertube(clientType = 'WEB') {
  if (!sessions.has(clientType)) {
    const opts = {
      lang: process.env.YT_LANG || 'pt',
      location: process.env.YT_LOCATION || 'BR',
      ...(clientType !== 'WEB' ? { client_type: clientType } : {}),
      ...(process.env.YT_COOKIE ? { cookie: process.env.YT_COOKIE } : {}),
    };
    sessions.set(
      clientType,
      Innertube.create(opts).catch((err) => {
        // Permite retry na próxima chamada
        sessions.delete(clientType);
        throw err;
      })
    );
  }
  return sessions.get(clientType);
}
