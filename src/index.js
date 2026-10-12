require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { getInnertube } = require('./ytClient');
const {
  cacheGet,
  cacheSet,
  normalizeVideo,
  extractVideoId,
  median,
  mean,
  videoUrl,
} = require('./utils');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true }));

// ---------- helpers ----------

function ok(res, data, cached = false) {
  res.set('X-Cache', cached ? 'HIT' : 'MISS');
  return res.json({ success: true, ...data });
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, error: message, ...extra });
}

function dedupe(videos) {
  const seen = new Set();
  return videos.filter((v) => {
    if (!v || !v.video_id || seen.has(v.video_id)) return false;
    seen.add(v.video_id);
    return true;
  });
}

// Busca: usa search.videos (formato estável no v18) + continuações
async function searchVideos(innertube, query, limit = 20, channelFallback = null) {
  const search = await innertube.search(query, { type: 'video' });
  let videos = [];
  if (Array.isArray(search.videos)) {
    for (const n of search.videos) {
      const v = normalizeVideo(n, channelFallback);
      if (v) videos.push(v);
    }
  }
  // Fallback: resultados genéricos
  if (!videos.length && search.results?.contents) {
    for (const item of search.results.contents) {
      const n = item?.content || item;
      const v = normalizeVideo(n, channelFallback);
      if (v) videos.push(v);
    }
  }
  let cont = search;
  let guard = 0;
  while (videos.length < limit && cont?.has_continuation && guard < 5) {
    guard++;
    try {
      cont = await cont.getContinuation();
      const batch = Array.isArray(cont.videos) ? cont.videos : cont.results?.contents || [];
      for (const item of batch) {
        const n = item?.content || item;
        const v = normalizeVideo(n, channelFallback);
        if (v) videos.push(v);
      }
      videos = dedupe(videos);
    } catch { break; }
  }
  return dedupe(videos).slice(0, limit);
}

// Resolve @handle, nome ou URL -> UC channel id (via busca de canal)
async function resolveChannelId(innertube, ref) {
  ref = String(ref).trim();
  if (/^UC[\w-]{22}$/.test(ref)) return ref;
  const urlId = ref.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  if (urlId) return urlId[1];

  // Tenta extrair @handle da URL
  const handleMatch = ref.match(/youtube\.com\/@([^\/\s?]+)/);
  const query = handleMatch ? '@' + handleMatch[1] : ref;

  const s = await innertube.search(query, { type: 'channel' });
  const channels = Array.isArray(s.channels) ? s.channels : [];
  if (channels.length) {
    const id = channels[0].id || channels[0].channel_id;
    if (id) return id;
  }
  throw new Error(`Canal não encontrado para "${ref}". Use @handle, nome ou ID UC...`);
}

// Lê itens da aba do canal (Channel ou FilteredChannelList ou continuação)
function readItems(feed) {
  if (!feed) return [];
  // FilteredChannelList / ChannelListContinuation
  if (Array.isArray(feed.contents)) {
    // contents pode ser array de RichItem ou o objeto AppendContinuationItemsAction
    return feed.contents;
  }
  if (feed.contents?.contents && Array.isArray(feed.contents.contents)) {
    return feed.contents.contents;
  }
  // Channel normal
  const contents = feed.current_tab?.content?.contents;
  if (Array.isArray(contents)) return contents;
  return [];
}

function channelMeta(feed, fallbackId) {
  const md = feed?.metadata || {};
  return {
    channel_id: md.external_id || fallbackId,
    channel_title: md.title || null,
    channel_url: md.url || (fallbackId ? `https://www.youtube.com/channel/${fallbackId}` : null),
    vanity_url: md.vanity_channel_url || null,
    description: md.description ? String(md.description).slice(0, 500) : null,
    avatar: md.avatar?.[0]?.url || md.thumbnail?.[0]?.url || null,
  };
}

async function fetchChannelTab(innertube, channelId, tab = 'videos', limit = 30, sort = 'new') {
  let channel = await innertube.getChannel(channelId);
  let feed = tab === 'shorts' ? await channel.getShorts() : await channel.getVideos();

  // sort=popular: tenta filtro "Em alta" (pt) / "Popular" (en)
  if (sort === 'popular' && tab === 'videos' && typeof feed.applyFilter === 'function') {
    const wanted = (feed.filters || []).find((f) => /alta|popular|top|trending/i.test(f));
    if (wanted) {
      try {
        const filtered = await feed.applyFilter(wanted);
        const items = readItems(filtered);
        if (items.length) feed = filtered;
      } catch { /* mantém ordem padrão */ }
    }
  }

  const metaHolder = feed?.metadata ? feed : channel;
  const meta = channelMeta(metaHolder, channelId);
  const channelName = meta.channel_title;

  let rawItems = readItems(feed);
  let videos = [];
  for (const item of rawItems) {
    const v = normalizeVideo(item?.content || item, channelName);
    if (v) {
      if (!v.channel_id) v.channel_id = meta.channel_id;
      if (!v.channel) v.channel = channelName;
      videos.push(v);
    }
  }

  // Paginação (Channel.getContinuation -> ChannelListContinuation)
  let cursor = feed;
  let guard = 0;
  while (videos.length < limit && cursor?.has_continuation && guard < 8) {
    guard++;
    try {
      cursor = await cursor.getContinuation();
      for (const item of readItems(cursor)) {
        const v = normalizeVideo(item?.content || item, channelName);
        if (v && !videos.some((x) => x.video_id === v.video_id)) {
          if (!v.channel_id) v.channel_id = meta.channel_id;
          if (!v.channel) v.channel = channelName;
          videos.push(v);
        }
        if (videos.length >= limit) break;
      }
    } catch { break; }
  }

  return { meta, videos: dedupe(videos).slice(0, limit) };
}

function classifyDuration(v) {
  if (v.is_short) return 'short';
  if ((v.duration_seconds || 0) >= 20 * 60) return 'long_20min_plus';
  if ((v.duration_seconds || 0) >= 8 * 60) return 'long_8min_plus';
  return 'video';
}

// Transcrição via youtube-transcript-plus (confiável, sem API key)
function decodeHTMLEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

async function fetchTranscriptSegments(videoId, lang = 'pt') {
  const { fetchTranscript } = require('youtube-transcript-plus');
  const langsToTry = [lang, lang.split('-')[0], 'pt', 'en'];
  let lastErr = null;
  for (const l of [...new Set(langsToTry)]) {
    try {
      const segs = await fetchTranscript(videoId, { lang: l });
      if (segs && segs.length) {
        return {
          segments: segs.map((s) => ({
            text: decodeHTMLEntities(s.text),
            start: s.offset,
            end: s.offset + s.duration,
            start_ms: Math.round(s.offset * 1000),
            end_ms: Math.round((s.offset + s.duration) * 1000),
            lang: s.lang,
          })),
          lang_used: segs[0]?.lang || l,
        };
      }
    } catch (e) { lastErr = e; }
  }
  // Fallback: sem lang (deixa a lib escolher)
  try {
    const segs = await fetchTranscript(videoId);
    if (segs && segs.length) {
      return {
        segments: segs.map((s) => ({
          text: decodeHTMLEntities(s.text),
          start: s.offset,
          end: s.offset + s.duration,
          start_ms: Math.round(s.offset * 1000),
          end_ms: Math.round((s.offset + s.duration) * 1000),
          lang: s.lang,
        })),
        lang_used: segs[0]?.lang || 'auto',
      };
    }
  } catch (e) { lastErr = e; }
  throw lastErr || new Error('Sem transcrição');
}

// ---------- rotas ----------

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>YT Scraper API</title>
<style>body{font-family:system-ui,Arial;max-width:860px;margin:32px auto;padding:0 16px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px}pre{background:#111827;color:#e5e7eb;padding:14px;border-radius:10px;overflow:auto}
a{color:#2563eb}.badge{display:inline-block;background:#ecfdf5;color:#065f46;padding:2px 10px;border-radius:999px;font-size:12px}</style>
</head><body>
<h1>🎬 YT Scraper API <span class="badge">online</span></h1>
<p>Scraping do YouTube sem chave de API: busca, vídeos, shorts, transcrições e <b>outliers</b>.</p>
<h2>Endpoints</h2>
<pre>GET  /health
GET  /api/search?q=&amp;limit=&amp;type=video|shorts|all
GET  /api/video/:id                      (aceita ID ou URL)
GET  /api/video/:id/transcript?lang=pt&amp;format=json|text|srt
GET  /api/channel/:ref/videos?limit=&amp;sort=new|popular&amp;filter=all|short|long
GET  /api/channel/:ref/shorts?limit=
POST /api/bulk/videos  { "ids": ["abc...","def..."] }
GET  /api/outliers?channel=@canal&amp;limit=&amp;threshold=&amp;minViews=&amp;filter=
GET  /api/search-outliers?q=&amp;limit=&amp;threshold=</pre>
<h2>Exemplos</h2>
<p><code>/api/search?q=inteligencia artificial&amp;limit=10</code></p>
<p><code>/api/outliers?channel=@MrBeast&amp;limit=30&amp;threshold=2</code></p>
<p>Docs completas no <code>README.md</code>. Deploy pronto p/ Render com <code>render.yaml</code>.</p>
</body></html>`);
});

app.get('/health', (req, res) => res.json({ success: true, status: 'ok', uptime: process.uptime() }));

// ---- BUSCA ----
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  const type = (req.query.type || 'all').toString().toLowerCase();
  if (!q) return fail(res, 400, 'Parâmetro "q" é obrigatório. Ex: /api/search?q=financas&limit=20');

  const cacheKey = `search:${q}:${limit}:${type}`;
  const hit = cacheGet(cacheKey);
  if (hit) return ok(res, hit, true);

  try {
    const innertube = await getInnertube();
    let videos = await searchVideos(innertube, q, type === 'shorts' ? limit * 2 : limit);
    if (type === 'shorts') videos = videos.filter((v) => v.is_short);
    if (type === 'video' || type === 'long') videos = videos.filter((v) => !v.is_short);
    videos = videos.slice(0, limit);
    const payload = { query: q, count: videos.length, results: videos };
    cacheSet(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 502, 'Falha na busca. Tente novamente.', { detail: e.message });
  }
});

// ---- DETALHES DO VÍDEO ----
app.get('/api/video/:id', async (req, res) => {
  const id = extractVideoId(req.params.id);
  if (!id) return fail(res, 400, 'ID de vídeo inválido. Use 11 caracteres ou URL completa.');

  const cacheKey = `video:${id}`;
  const hit = cacheGet(cacheKey);
  if (hit) return ok(res, hit, true);

  try {
    const innertube = await getInnertube();
    const info = await innertube.getInfo(id);
    const b = info.basic_info || {};
    const p = info.primary_info || {};

    const views = Number(b.view_count) || 0;
    const likes = b.like_count != null ? Number(b.like_count) : null;
    const duration = Number(b.duration) || 0;

    const payload = {
      video: {
        video_id: id,
        title: b.title || p.title?.text || '',
        description: String(b.short_description || '').slice(0, 2000),
        channel: b.channel?.name || null,
        channel_id: b.channel?.id || null,
        views,
        likes,
        comment_count: b.comment_count != null ? Number(b.comment_count) : null,
        duration_seconds: duration,
        duration_text: duration ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : null,
        published_text: p.published?.text || null,
        is_short: duration > 0 && duration <= 61,
        is_live: !!b.is_live,
        thumbnail: b.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: videoUrl(id),
        shorts_url: `https://www.youtube.com/shorts/${id}`,
        embed_url: `https://www.youtube.com/embed/${id}`,
        keywords: b.keywords || [],
        category: b.category || null,
        captions_available: (info.captions?.caption_tracks?.length || 0) > 0,
        caption_languages: (info.captions?.caption_tracks || []).map((t) => t.language_code),
      },
    };
    cacheSet(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 502, 'Não foi possível obter o vídeo. Verifique o ID.', { detail: e.message });
  }
});

// ---- TRANSCRIÇÃO ----
app.get('/api/video/:id/transcript', async (req, res) => {
  const id = extractVideoId(req.params.id);
  if (!id) return fail(res, 400, 'ID de vídeo inválido.');
  const lang = (req.query.lang || 'pt').toString();
  const format = (req.query.format || 'json').toString().toLowerCase();

  const cacheKey = `transcript:${id}:${lang}`;
  const hit = cacheGet(cacheKey);
  if (hit) {
    if (format === 'text') return res.type('text/plain').send(hit.text);
    if (format === 'srt') return res.type('text/plain').send(toSRT(hit.segments));
    return ok(res, hit, true);
  }

  try {
    const { segments, lang_used } = await fetchTranscriptSegments(id, lang);
    const fullText = segments.map((s) => s.text).join(' ');
    const payload = { video_id: id, language_requested: lang, language_used: lang_used, count: segments.length, text: fullText, segments };
    cacheSet(cacheKey, payload, 3600);

    if (format === 'text') return res.type('text/plain').send(fullText);
    if (format === 'srt') return res.type('text/plain').send(toSRT(segments));
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 404, 'Este vídeo não possui transcrição/legendas disponíveis.', { video_id: id });
  }
});

function toSRT(segments) {
  const fmt = (sec) => {
    sec = Math.max(0, sec);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.floor((sec % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  return segments.map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end || s.start + 2)}\n${s.text}\n`).join('\n');
}

// ---- VÍDEOS DO CANAL ----
app.get('/api/channel/:ref/videos', async (req, res) => {
  const ref = req.params.ref;
  const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 50);
  const sort = (req.query.sort || 'new').toString();
  const filter = (req.query.filter || 'all').toString().toLowerCase();

  const cacheKey = `channel:videos:${ref}:${limit}:${sort}:${filter}`;
  const hit = cacheGet(cacheKey);
  if (hit) return ok(res, hit, true);

  try {
    const innertube = await getInnertube();
    const channelId = await resolveChannelId(innertube, ref);
    const { meta, videos } = await fetchChannelTab(innertube, channelId, 'videos', filter === 'short' ? limit * 2 : limit, sort);

    let filtered = videos;
    if (filter === 'short' || filter === 'shorts') filtered = videos.filter((v) => v.is_short);
    if (filter === 'long') filtered = videos.filter((v) => !v.is_short);
    // sort=popular com fallback client-side (caso o filtro da UI não retorne itens)
    if (sort === 'popular') filtered = [...filtered].sort((a, b) => (b.views || 0) - (a.views || 0));

    const enriched = filtered.slice(0, limit).map((v) => ({ ...v, format: classifyDuration(v) }));
    const payload = { channel: meta, count: enriched.length, sort, filter, videos: enriched };
    cacheSet(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 502, 'Falha ao listar vídeos do canal. Verifique @handle, ID ou URL.', { detail: e.message });
  }
});

// ---- SHORTS DO CANAL ----
app.get('/api/channel/:ref/shorts', async (req, res) => {
  const ref = req.params.ref;
  const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 50);

  const cacheKey = `channel:shorts:${ref}:${limit}`;
  const hit = cacheGet(cacheKey);
  if (hit) return ok(res, hit, true);

  try {
    const innertube = await getInnertube();
    const channelId = await resolveChannelId(innertube, ref);
    let data;
    try {
      data = await fetchChannelTab(innertube, channelId, 'shorts', limit, 'new');
    } catch {
      data = await fetchChannelTab(innertube, channelId, 'videos', limit * 2, 'new');
      data.videos = data.videos.filter((v) => v.is_short);
    }
    const payload = { channel: data.meta, count: Math.min(data.videos.length, limit), shorts: data.videos.slice(0, limit) };
    cacheSet(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 502, 'Falha ao listar shorts do canal.', { detail: e.message });
  }
});

// ---- BULK ----
app.post('/api/bulk/videos', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return fail(res, 400, 'Envie { "ids": ["videoId1", "videoId2"] } (máx 20).');
  if (ids.length > 20) return fail(res, 400, 'Máximo de 20 IDs por requisição.');

  try {
    const innertube = await getInnertube();
    const results = [];
    for (const raw of ids) {
      const id = extractVideoId(raw);
      if (!id) { results.push({ input: raw, error: 'ID inválido' }); continue; }
      try {
        const info = await innertube.getInfo(id);
        const b = info.basic_info || {};
        results.push({
          video_id: id,
          title: b.title || '',
          channel: b.channel?.name || null,
          channel_id: b.channel?.id || null,
          views: Number(b.view_count) || 0,
          duration_seconds: Number(b.duration) || 0,
          url: videoUrl(id),
        });
      } catch (e) {
        results.push({ input: raw, video_id: id, error: e.message });
      }
    }
    return ok(res, { count: results.length, results });
  } catch (e) {
    return fail(res, 502, 'Falha no bulk.', { detail: e.message });
  }
});

// ---- OUTLIERS POR CANAL ----
// Outlier = views bem acima da mediana do canal (score = views / mediana)
app.get('/api/outliers', async (req, res) => {
  const channelRef = (req.query.channel || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 50);
  const threshold = parseFloat(req.query.threshold || '2') || 2;
  const minViews = parseInt(req.query.minViews || req.query.min_views || '0', 10) || 0;
  const filter = (req.query.filter || 'all').toString().toLowerCase();

  if (!channelRef) return fail(res, 400, 'Parâmetro "channel" é obrigatório. Ex: /api/outliers?channel=@MrBeast&limit=30&threshold=2');

  const cacheKey = `outliers:${channelRef}:${limit}:${threshold}:${minViews}:${filter}`;
  const hit = cacheGet(cacheKey);
  if (hit) return ok(res, hit, true);

  try {
    const innertube = await getInnertube();
    const channelId = await resolveChannelId(innertube, channelRef);
    const { meta, videos } = await fetchChannelTab(innertube, channelId, 'videos', limit, 'new');

    let pool = videos;
    if (filter === 'short' || filter === 'shorts') pool = videos.filter((v) => v.is_short);
    if (filter === 'long') pool = videos.filter((v) => !v.is_short);
    pool = pool.filter((v) => (v.views || 0) >= minViews);

    if (!pool.length) return fail(res, 404, 'Nenhum vídeo encontrado para esses filtros.', { channel: meta });

    const views = pool.map((v) => v.views || 0);
    const med = median(views);
    const avg = mean(views);
    const base = med > 0 ? med : avg;

    const scored = pool.map((v) => ({
      ...v,
      format: classifyDuration(v),
      outlier_score: base > 0 ? Number(((v.views || 0) / base).toFixed(2)) : 0,
      is_outlier: base > 0 ? (v.views || 0) / base >= threshold : false,
    })).sort((a, b) => b.outlier_score - a.outlier_score);

    const outliers = scored.filter((v) => v.is_outlier);
    const payload = {
      channel: meta,
      stats: {
        analyzed: pool.length, median_views: Math.round(med), mean_views: Math.round(avg),
        threshold, minViews, filter,
      },
      outliers_count: outliers.length,
      outliers,
      all_videos_ranked: scored,
    };
    cacheSet(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 502, 'Falha ao calcular outliers.', { detail: e.message });
  }
});

// ---- OUTLIERS POR BUSCA (acha vídeos que estouraram num nicho) ----
app.get('/api/search-outliers', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  const threshold = parseFloat(req.query.threshold || '2') || 2;
  if (!q) return fail(res, 400, 'Parâmetro "q" é obrigatório. Ex: /api/search-outliers?q=financas&limit=20');

  const cacheKey = `search-outliers:${q}:${limit}:${threshold}`;
  const hit = cacheGet(cacheKey);
  if (hit) return ok(res, hit, true);

  try {
    const innertube = await getInnertube();
    const videos = await searchVideos(innertube, q, limit);
    if (!videos.length) return fail(res, 404, 'Nenhum vídeo encontrado.');

    const views = videos.map((v) => v.views || 0);
    const med = median(views);
    const avg = mean(views);
    const base = med > 0 ? med : avg;

    const scored = videos.map((v) => ({
      ...v,
      format: classifyDuration(v),
      outlier_score: base > 0 ? Number(((v.views || 0) / base).toFixed(2)) : 0,
      is_outlier: base > 0 ? (v.views || 0) / base >= threshold : false,
    })).sort((a, b) => b.outlier_score - a.outlier_score);

    const payload = {
      query: q,
      stats: { analyzed: videos.length, median_views: Math.round(med), mean_views: Math.round(avg), threshold },
      outliers_count: scored.filter((v) => v.is_outlier).length,
      outliers: scored.filter((v) => v.is_outlier),
      all_videos_ranked: scored,
    };
    cacheSet(cacheKey, payload);
    return ok(res, payload);
  } catch (e) {
    console.error(e);
    return fail(res, 502, 'Falha na busca de outliers.', { detail: e.message });
  }
});

app.use((req, res) => fail(res, 404, `Rota não encontrada: ${req.method} ${req.path}`));

app.listen(PORT, () => {
  console.log(`🚀 YT Scraper API rodando na porta ${PORT}`);
});
