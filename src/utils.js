// Utils: parsing, cache, normalização (compatível youtubei.js v18)

const cache = new Map();
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlSeconds = DEFAULT_TTL) {
  cache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

// ---- Números: "1,2 mi", "340 mil", "238 mi", "1.5M", "10K" -> number ----
// Em pt-BR: "mi" = milhões, "mil" = milhares.
function parseViews(text) {
  if (text == null) return 0;
  if (typeof text === 'number') return text;
  let s = String(text).toLowerCase().trim();
  if (!s) return 0;
  s = s.replace(/visualiza[çc][õo]es|views|view|de |assistir/g, '').trim();

  const numPart = s.replace(/[^\d.,]/g, '');
  // "1,2 mi" -> 1.2 ; "15.655" -> 15655 ; "238 mi" -> 238
  const toNum = (raw) => {
    raw = raw.trim();
    if (!raw) return 0;
    if (raw.includes(',') && raw.includes('.')) {
      // "1.234,5" (pt) -> remove milhar, vírgula vira ponto
      return parseFloat(raw.replace(/\./g, '').replace(',', '.')) || 0;
    }
    if (raw.includes(',')) return parseFloat(raw.replace(',', '.')) || 0;
    // "15.655" sem vírgula: ponto é milhar se 3 dígitos após
    if (/^\d{1,3}(\.\d{3})+$/.test(raw)) return parseInt(raw.replace(/\./g, ''), 10) || 0;
    return parseFloat(raw) || 0;
  };

  if (/\bmi\b/.test(s)) return Math.round(toNum(numPart) * 1e6);
  if (/\bmil\b/.test(s)) return Math.round(toNum(numPart) * 1e3);
  if (/\bbi\b|\bb\b/.test(s) && /bilh/.test(s)) return Math.round(toNum(numPart) * 1e9);
  if (/\bk\b/.test(s)) return Math.round(toNum(numPart) * 1e3);
  if (/\bm\b/.test(s) && !/\bmi\b/.test(s)) {
    // inglês "1.2M"
    if (/m/.test(s)) return Math.round(toNum(numPart) * 1e6);
  }
  const digits = s.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

function parseDurationToSeconds(input) {
  if (input == null) return 0;
  if (typeof input === 'number') return input;
  if (typeof input === 'object' && input.seconds != null) return Number(input.seconds);
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // "57:59", "1:02:03", "0:34"
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return total;
}

function videoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}
function shortsUrl(id) {
  return `https://www.youtube.com/shorts/${id}`;
}

function median(numbers) {
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function textOf(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t.text === 'string') return t.text;
  return String(t.text || t);
}

// Extrai duração de overlays do LockupView
function durationFromOverlays(node) {
  try {
    const overlays = node?.content_image?.overlays || [];
    for (const o of overlays) {
      for (const b of o?.badges || []) {
        if (b?.text && /^\d+:\d+/.test(b.text)) return b.text;
      }
    }
  } catch { /* */ }
  return null;
}

// Normaliza qualquer nó de vídeo (Search Video, LockupView, ShortsLockupView)
function normalizeVideo(node, channelFallback = null) {
  try {
    if (!node || typeof node !== 'object') return null;
    const type = node.type;

    // ---- Shorts (aba shorts): ShortsLockupView ----
    if (type === 'ShortsLockupView') {
      const id = node.on_tap_endpoint?.payload?.videoId || node.entity_id?.replace('shorts-shelf-item-', '');
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
      const title = textOf(node.overlay_metadata?.primary_text) || textOf(node.accessibility_text) || '';
      const thumb = node.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      const viewsText = textOf(node.overlay_metadata?.secondary_text) || '';
      return {
        video_id: id,
        title: String(title).trim(),
        channel: channelFallback,
        channel_id: null,
        views: parseViews(viewsText),
        views_text: viewsText,
        duration_seconds: 0,
        duration_text: null,
        published_text: null,
        thumbnail: thumb,
        url: videoUrl(id),
        shorts_url: shortsUrl(id),
        is_short: true,
      };
    }

    // ---- LockupView (aba vídeos do canal no v18) ----
    if (type === 'LockupView') {
      const id = node.content_id;
      if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
      const isShort = node.content_type === 'SHORT';
      const title = textOf(node.metadata?.title);
      const rows = node.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts || [];
      const viewsText = textOf(rows[0]?.text);
      const publishedText = textOf(rows[1]?.text) || null;
      const durText = durationFromOverlays(node);
      const durSecs = parseDurationToSeconds(durText);
      const thumb = node.content_image?.image?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      return {
        video_id: id,
        title: String(title),
        channel: channelFallback,
        channel_id: null,
        views: parseViews(viewsText),
        views_text: viewsText,
        duration_seconds: durSecs,
        duration_text: durText,
        published_text: publishedText,
        thumbnail: thumb,
        url: isShort ? shortsUrl(id) : videoUrl(id),
        shorts_url: shortsUrl(id),
        is_short: isShort || (durSecs > 0 && durSecs <= 61),
      };
    }

    // ---- Reel (shorts em busca) ----
    if (type === 'Reel' || type === 'ReelItem' || type === 'ShortsLockupViewModel') {
      const id = node.video_id || node.id;
      if (!id) return null;
      return {
        video_id: id,
        title: textOf(node.title) || textOf(node.headline) || '',
        channel: channelFallback || textOf(node.author?.name),
        channel_id: node.author?.id || null,
        views: parseViews(textOf(node.view_count) || textOf(node.views)),
        views_text: textOf(node.view_count) || '',
        duration_seconds: 0,
        duration_text: null,
        published_text: textOf(node.published) || null,
        thumbnail: node.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        url: shortsUrl(id),
        shorts_url: shortsUrl(id),
        is_short: true,
      };
    }

    // ---- Vídeo clássico (busca, relacionados) ----
    const id = node.video_id || node.id;
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(String(id))) return null;

    const title = textOf(node.title);
    const author = node.author?.name || channelFallback || null;
    const channelId = node.author?.id || null;
    const viewsRaw = node.view_count?.text || node.views?.text || node.short_view_count?.text || node.view_count || '0';
    const views = typeof viewsRaw === 'number' ? viewsRaw : parseViews(viewsRaw);
    const durationRaw = node.duration?.text || node.duration || node.length_text?.text || durationFromOverlays(node);
    const duration_seconds = parseDurationToSeconds(durationRaw);
    const published = node.published?.text || null;
    const thumbs = node.thumbnails;
    const thumbnail = Array.isArray(thumbs)
      ? thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
      : thumbs?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const is_short =
      (duration_seconds > 0 && duration_seconds <= 61) ||
      String(node.url || '').includes('/shorts/');

    return {
      video_id: String(id),
      title: String(title),
      channel: author ? String(author) : channelFallback,
      channel_id: channelId,
      views,
      views_text: String(viewsRaw?.text || viewsRaw || ''),
      duration_seconds,
      duration_text: typeof durationRaw === 'string' ? durationRaw : null,
      published_text: published ? String(published) : null,
      thumbnail,
      url: videoUrl(id),
      shorts_url: shortsUrl(id),
      is_short,
    };
  } catch {
    return null;
  }
}

function extractVideoId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const m =
    input.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
    input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
    input.match(/shorts\/([a-zA-Z0-9_-]{11})/) ||
    input.match(/\/live\/([a-zA-Z0-9_-]{11})/) ||
    input.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

module.exports = {
  cacheGet,
  cacheSet,
  parseViews,
  parseDurationToSeconds,
  normalizeVideo,
  extractVideoId,
  median,
  mean,
  videoUrl,
  shortsUrl,
};
