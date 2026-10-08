// Generates simple placeholder SVG art for every definition plus a few backgrounds and props.
// Re-run with `npm run placeholders`; existing files are left alone unless --force is passed.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent } from '../server/content.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const out = (rel, svg) => {
  const file = join(ROOT, rel.replace(/^\//, ''));
  if (existsSync(file) && !force) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, svg.trim() + '\n');
  console.log('wrote', rel);
};

const ROLE_COLORS = { tank: '#3b6fb6', dps: '#b83b3b', heal: '#3b9a5a' };
const initials = (name) => name.split(/\s+/).filter((w) => !/^(the|of)$/i.test(w)).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function token(name, fill, ring) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs><radialGradient id="g" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></radialGradient></defs>
  <circle cx="64" cy="64" r="60" fill="${fill}" stroke="${ring}" stroke-width="6"/>
  <circle cx="64" cy="64" r="60" fill="url(#g)"/>
  <text x="64" y="80" font-family="Georgia, serif" font-size="48" font-weight="bold" text-anchor="middle" fill="#fff" stroke="#000" stroke-opacity=".4" stroke-width="2">${esc(initials(name))}</text>
</svg>`;
}

function bigImage(name, fill) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="48" fill="${fill}" stroke="#1a0d0d" stroke-width="8"/>
  <path d="M40 200 Q128 40 216 200 Z" fill="#000" opacity=".2"/>
  <text x="128" y="150" font-family="Georgia, serif" font-size="88" font-weight="bold" text-anchor="middle" fill="#fff" stroke="#000" stroke-opacity=".4" stroke-width="3">${esc(initials(name))}</text>
</svg>`;
}

const content = loadContent(join(ROOT, 'data'));
for (const c of content.characters) if (c.image) out(c.image, token(c.name, ROLE_COLORS[c.role] ?? '#666', '#e8d9a8'));
for (const m of content.monsters) if (m.image) out(m.image, (m.size?.w ?? 1) > 1 ? bigImage(m.name, '#7a1f1f') : token(m.name, '#6b2a2a', '#1a0d0d'));
for (const n of content.npcs) if (n.image) out(n.image, token(n.name, '#8a6d2f', '#f0e0b0'));

// Props
const props = {
  chest: '<rect x="16" y="36" width="96" height="64" rx="8" fill="#8b5a2b" stroke="#3b2410" stroke-width="6"/><rect x="16" y="36" width="96" height="22" fill="#a0692f" stroke="#3b2410" stroke-width="6"/><rect x="56" y="52" width="16" height="18" fill="#e0b84a" stroke="#3b2410" stroke-width="3"/>',
  barrel: '<ellipse cx="64" cy="64" rx="44" ry="54" fill="#8b5a2b" stroke="#3b2410" stroke-width="6"/><path d="M24 40 H104 M22 88 H106" stroke="#555" stroke-width="7"/>',
  rock: '<path d="M18 92 L30 44 L62 22 L98 34 L112 78 L90 106 L40 108 Z" fill="#7d7d7d" stroke="#3a3a3a" stroke-width="6"/><path d="M44 52 L70 40 L88 60" stroke="#9a9a9a" stroke-width="5" fill="none"/>',
  door: '<rect x="28" y="10" width="72" height="108" rx="6" fill="#6b4423" stroke="#2b1a0b" stroke-width="6"/><path d="M52 10 V118 M76 10 V118" stroke="#4a2e15" stroke-width="4"/><circle cx="88" cy="66" r="6" fill="#e0b84a"/>',
  table: '<rect x="10" y="22" width="108" height="84" rx="10" fill="#9a6a3a" stroke="#3b2410" stroke-width="6"/><path d="M10 50 H118 M10 78 H118" stroke="#7a4f27" stroke-width="3"/>',
  lever: '<rect x="40" y="88" width="48" height="24" rx="4" fill="#555" stroke="#222" stroke-width="5"/><path d="M64 96 L92 26" stroke="#888" stroke-width="10" stroke-linecap="round"/><circle cx="92" cy="26" r="11" fill="#c0392b" stroke="#222" stroke-width="4"/>',
  pillar: '<circle cx="64" cy="64" r="52" fill="#9b9b8f" stroke="#4a4a42" stroke-width="7"/><circle cx="64" cy="64" r="34" fill="none" stroke="#b5b5a8" stroke-width="5"/>',
  bush: '<circle cx="44" cy="70" r="32" fill="#2f6b2f"/><circle cx="84" cy="66" r="34" fill="#357a35"/><circle cx="64" cy="42" r="30" fill="#3d8a3d" stroke="#1d401d" stroke-width="4"/>',
};
for (const [name, body] of Object.entries(props)) {
  out(`/static/images/${name}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">${body}</svg>`);
}

// Backgrounds (no grid baked in — the grid is configured per scene).
const W = 1280, H = 896;
const bg = (defs, fill, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs><rect width="${W}" height="${H}" fill="${fill}"/>${extra}</svg>`;
out('/static/backgrounds/tavern.svg', bg(
  '<pattern id="p" width="160" height="40" patternUnits="userSpaceOnUse"><rect width="160" height="40" fill="#7a5230"/><path d="M0 40 H160 M100 0 V40" stroke="#4e3218" stroke-width="3"/><path d="M10 14 Q60 10 90 18" stroke="#8d6038" stroke-width="2" fill="none"/></pattern>',
  'url(#p)', `<rect x="0" y="0" width="${W}" height="64" fill="#3d2a1a"/><rect x="40" y="96" width="420" height="60" fill="#5a3a1e" stroke="#2b1a0b" stroke-width="5"/><circle cx="1150" cy="140" r="70" fill="#c1440e" opacity=".35"/>`));
out('/static/backgrounds/dungeon.svg', bg(
  '<pattern id="p" width="128" height="128" patternUnits="userSpaceOnUse"><rect width="128" height="128" fill="#44434a"/><path d="M0 0 H128 M0 64 H128 M0 0 V64 M64 64 V128" stroke="#2c2b31" stroke-width="5"/><circle cx="30" cy="30" r="4" fill="#4f4e56"/><circle cx="96" cy="98" r="6" fill="#3b3a40"/></pattern>',
  'url(#p)', `<rect width="${W}" height="${H}" fill="none" stroke="#1d1c21" stroke-width="80"/>`));
out('/static/backgrounds/forest.svg', bg(
  '<pattern id="p" width="96" height="96" patternUnits="userSpaceOnUse"><rect width="96" height="96" fill="#4c7a3a"/><circle cx="20" cy="24" r="10" fill="#558542"/><circle cx="70" cy="60" r="14" fill="#44702f"/><path d="M40 80 l4 -10 l4 10" stroke="#6a9a52" stroke-width="2" fill="none"/></pattern>',
  'url(#p)', `<path d="M0 520 C300 440 520 640 820 560 S1200 480 ${W} 540 V640 C1100 600 900 700 640 660 S200 580 0 640 Z" fill="#a08a5c" opacity=".85"/>`));
out('/static/backgrounds/cave.svg', bg(
  '<radialGradient id="r" cx="50%" cy="50%" r="65%"><stop offset="0" stop-color="#5a4a3c"/><stop offset="1" stop-color="#1d1611"/></radialGradient>',
  'url(#r)', '<ellipse cx="900" cy="600" rx="180" ry="90" fill="#24435a" opacity=".7"/>'));
