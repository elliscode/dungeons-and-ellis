export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tiny element builder: h('button.primary', { onclick }, 'Text', child)
export function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// replaceChildren that skips null/false (for conditional children).
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

let toastBox;
export function toast(msg, kind = 'info') {
  toastBox ??= document.body.appendChild(h('div.toasts'));
  const t = toastBox.appendChild(h(`div.toast.${kind}`, {}, msg));
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Login required');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Sends a command over a socket; shows a toast on failure. Resolves to the result (or null).
export function sendCmd(socket, cmd, { quiet = false } = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit('cmd', cmd, (err, res) => {
      if (err) { toast('Server did not respond', 'error'); return resolve(null); }
      if (!res.ok) { if (!quiet) toast(res.error, 'error'); return resolve(null); }
      resolve(res.result ?? true);
    });
  });
}

export const ROLE_LABELS = { tank: 'Tank', dps: 'DPS', heal: 'Heal' };
export const ROLE_ICONS = { tank: '🛡️', dps: '⚔️', heal: '✚' };
export const PLAYER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#ffe119'];
export const DM_COLOR = '#d4af37';

// Phase banner + authoritative countdown. Call update() with each state.
export function combatBar(el) {
  let combat = null, offset = 0;
  const render = () => {
    if (!combat?.active) {
      el.className = 'combat-bar idle';
      el.textContent = 'Exploring — no combat';
      return;
    }
    const phase = combat.phase === 'player' ? 'PLAYER PHASE' : 'DM PHASE';
    let timer = '', urgent = false;
    if (combat.phaseEndsAt) {
      const left = Math.max(0, Math.ceil((combat.phaseEndsAt - (Date.now() + offset)) / 1000));
      timer = ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      urgent = left <= 10;
    }
    el.className = `combat-bar ${combat.phase}${urgent ? ' urgent' : ''}`;
    el.textContent = `⚔️ ${phase} · Round ${combat.round}${timer}`;
  };
  setInterval(render, 250);
  return {
    update(c, serverNow) {
      combat = c;
      if (serverNow) offset = serverNow - Date.now();
      render();
    },
  };
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => toast('Copied!'));
  const ta = document.body.appendChild(h('textarea', { value: text }));
  ta.select();
  document.execCommand('copy');
  ta.remove();
  toast('Copied!');
}

// Floating menu anchored at a screen point. Items: {label, sub, disabled, onClick} or {heading}.
let openMenu = null;
export function popupMenu(x, y, title, items, { className = '' } = {}) {
  closeMenu();
  const menu = h(`div.popup-menu${className ? '.' + className : ''}`);
  if (title) menu.append(h('div.popup-title', {}, title));
  for (const it of items) {
    if (it.heading) { menu.append(h('div.popup-heading', {}, it.heading)); continue; }
    if (it.node) { menu.append(it.node); continue; }
    menu.append(h('button.popup-item', {
      disabled: !!it.disabled,
      title: it.title,
      onclick: (e) => { e.stopPropagation(); if (!it.keepOpen) closeMenu(); it.onClick?.(); },
    }, h('span.popup-label', {}, it.label), it.sub ? h('span.popup-sub', {}, it.sub) : null));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  openMenu = menu;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  return menu;
}
function outside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', outside, true);
}
