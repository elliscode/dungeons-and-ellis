import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';

// Server-rendered Open Graph / Twitter metadata for a game's share link, so link previews work
// for crawlers that never run JavaScript.

export const SITE_NAME = 'One & Done';
export const PREVIEW_DESCRIPTION = 'Join my game on One & Done!';
export const FALLBACK_IMAGE = '/static/og-default.png';
// Most preview crawlers can't render SVG, so only raster images are used.
const RASTER = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readHead(file, bytes = 65536) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

// Width/height from the image header (PNG, GIF, WebP, JPEG). Returns null if unknown.
export function imageSize(file) {
  let b;
  try { b = readHead(file); } catch { return null; }
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.subarray(0, 3).toString('latin1') === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = b.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      return {
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      };
    }
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// Maps a scene background (/static/...) to a raster file on disk. An SVG background falls back
// to a raster file with the same name (e.g. tavern.svg -> tavern.png) if one exists.
export function resolvePreviewImage(staticDir, background) {
  if (typeof background !== 'string' || !background.startsWith('/static/')) return null;
  const rel = decodeURIComponent(background.slice('/static/'.length).split('?')[0]);
  const ext = extname(rel).toLowerCase();
  const stem = rel.slice(0, rel.length - ext.length);
  const candidates = RASTER.includes(ext) ? [rel] : RASTER.map((e) => stem + e);
  const root = resolve(staticDir);
  for (const c of candidates) {
    const file = resolve(join(root, c));
    if (!file.startsWith(root + sep) || !existsSync(file)) continue;
    return { path: `/static/${c.split(sep).join('/')}`, file };
  }
  return null;
}

// Builds the <head> metadata for a game (or generic metadata when game is null).
// Only the game's name and its active map are used; no players or other private state.
export function previewMeta({ game, base, staticDir }) {
  const state = game?.state;
  const title = state?.name || SITE_NAME;
  const url = state ? `${base}/g/${encodeURIComponent(state.joinToken)}` : `${base}/`;
  const scene = state?.activeSceneId ? state.scenes[state.activeSceneId] : null;
  let img = scene ? resolvePreviewImage(staticDir, scene.background) : null;
  let version = scene && img ? scene.id : 'default';
  if (!img) {
    const file = join(staticDir, FALLBACK_IMAGE.slice('/static/'.length));
    img = { path: FALLBACK_IMAGE, file };
  }
  let size = null;
  try {
    // The version changes when the active scene or the file changes, so caches refetch the image.
    version += `-${Math.round(statSync(img.file).mtimeMs)}`;
    size = imageSize(img.file);
  } catch { /* fallback image missing: still emit the URL */ }
  const image = `${base}${img.path}?v=${encodeURIComponent(version)}`;
  const tags = [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', SITE_NAME],
    ['property', 'og:title', title],
    ['property', 'og:description', PREVIEW_DESCRIPTION],
    ['property', 'og:url', url],
    ['property', 'og:image', image],
    ...(image.startsWith('https://') ? [['property', 'og:image:secure_url', image]] : []),
    ...(size ? [['property', 'og:image:width', String(size.width)], ['property', 'og:image:height', String(size.height)]] : []),
    ['property', 'og:image:alt', scene ? `${title} — current map` : SITE_NAME],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', PREVIEW_DESCRIPTION],
    ['name', 'twitter:image', image],
    ['name', 'description', PREVIEW_DESCRIPTION],
  ];
  const html = [
    `<link rel="canonical" href="${esc(url)}">`,
    ...tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`),
  ].join('\n  ');
  return { title, html };
}

// Injects metadata into play.html at the <!--OG--> marker and sets the <title>.
export function renderPlayPage(template, meta) {
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace('<!--OG-->', meta.html);
}
