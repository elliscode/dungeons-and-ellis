import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const DM_COOKIE = 'one_and_done_dm';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ password, secret, now = Date.now }) {
  if (!password) throw new Error('DM_PASSWORD is required');
  const key = secret || createHash('sha256').update(`one-and-done:${password}`).digest('hex');
  const sign = (value) => createHmac('sha256', key).update(value).digest('base64url');

  return {
    checkPassword: (candidate) => safeEqual(String(candidate ?? ''), password),
    issueToken() {
      const payload = `dm.${now()}`;
      return `${payload}.${sign(payload)}`;
    },
    verifyToken(token) {
      if (typeof token !== 'string') return false;
      const i = token.lastIndexOf('.');
      if (i < 0) return false;
      const payload = token.slice(0, i);
      if (!safeEqual(sign(payload), token.slice(i + 1))) return false;
      const issued = Number(payload.split('.')[1]);
      return Number.isFinite(issued) && now() - issued < MAX_AGE_MS;
    },
    isDmCookieHeader(header) {
      return this.verifyToken(parseCookies(header)[DM_COOKIE]);
    },
    cookieMaxAgeMs: MAX_AGE_MS,
  };
}
