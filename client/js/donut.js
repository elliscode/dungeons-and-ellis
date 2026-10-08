// SVG action ring around a token. Four quarter segments: N Attack, E Move, S Inventory, W Act.
const NS = 'http://www.w3.org/2000/svg';
export const SEGMENTS = [
  { id: 'attack', label: 'Attack', icon: '⚔', angle: -90 },
  { id: 'move', label: 'Move', icon: '➜', angle: 0 },
  { id: 'inventory', label: 'Items', icon: '🎒', angle: 90 },
  { id: 'act', label: 'Act', icon: '✋', angle: 180 },
];

const rad = (deg) => (deg * Math.PI) / 180;
const pt = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];

function sector(cx, cy, r1, r2, a1, a2) {
  const [x1, y1] = pt(cx, cy, r2, a1), [x2, y2] = pt(cx, cy, r2, a2);
  const [x3, y3] = pt(cx, cy, r1, a2), [x4, y4] = pt(cx, cy, r1, a1);
  return `M${x1} ${y1} A${r2} ${r2} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${r1} ${r1} 0 0 0 ${x4} ${y4} Z`;
}

const el = (tag, attrs) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// tokenSize: px diameter of the token; disabled: Set of segment ids; down: replace with d20 roll.
export function buildDonut({ tokenSize, ring, disabled = new Set(), active = null, down = false, dead = false, onSegment, onRoll }) {
  const r1 = tokenSize / 2 + 2, r2 = r1 + ring;
  const size = r2 * 2 + 4, c = size / 2;
  const svg = el('svg', { class: 'donut', width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svg.style.left = svg.style.top = `${(tokenSize - size) / 2}px`;
  if (dead) return svg;
  for (const s of SEGMENTS) {
    const off = down || disabled.has(s.id);
    const g = el('g', { class: `seg seg-${s.id}${off ? ' off' : ''}${active === s.id ? ' active' : ''}` });
    g.append(el('path', { d: sector(c, c, r1, r2, s.angle - 44, s.angle + 44) }));
    const [tx, ty] = pt(c, c, (r1 + r2) / 2, s.angle);
    const t = el('text', { x: tx, y: ty, 'font-size': Math.max(11, ring * 0.5), 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.textContent = s.icon;
    g.append(t);
    const title = el('title', {});
    title.textContent = down ? 'You are down' : s.label + (off ? ' (unavailable)' : '');
    g.append(title);
    g.addEventListener('pointerdown', (e) => e.stopPropagation());
    g.addEventListener('click', (e) => { e.stopPropagation(); onSegment?.(s.id, e, off); });
    svg.append(g);
  }
  if (down) {
    const g = el('g', { class: 'seg seg-roll' });
    g.append(el('circle', { cx: c, cy: c + r1 + ring / 2, r: ring * 0.62 }));
    const t = el('text', { x: c, y: c + r1 + ring / 2, 'font-size': Math.max(10, ring * 0.38), 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.textContent = 'd20';
    g.append(t);
    const title = el('title', {});
    title.textContent = 'Roll a d20';
    g.append(title);
    g.addEventListener('pointerdown', (e) => e.stopPropagation());
    g.addEventListener('click', (e) => { e.stopPropagation(); onRoll?.(e); });
    svg.append(g);
  }
  return svg;
}
