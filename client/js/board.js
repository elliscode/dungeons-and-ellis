import { h } from './common.js';
import { buildDonut } from './donut.js';
import { zoomAt, clampPan, fitCamera, normalizeWheel, wheelIntent, wheelZoomFactor, pinchScaleFactor } from './camera.js';

const DRAG_THRESHOLD = 5;
const PING_HOLD_MS = 500;

// Renders a scene (background + independent grid) and tokens. Used by the player view, the DM
// view, and the scene editor. Tokens are plain descriptors:
//   { id, kind, name, image, size:{w,h}, position:{x,y}, z, hp?, maxHp?, status, color? }
export class Board {
  constructor(root, opts = {}) {
    this.opts = opts;
    this.root = root;
    // The camera: one transform for every map layer, translate(x, y) scale(zoom) on the stage.
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.autoFit = true;
    this.scene = null;
    this.tokens = [];
    this.view = {};
    this.drag = null;
    this.pendingRender = false;

    root.classList.add('board');
    this.viewport = h('div.board-viewport');
    this.stage = h('div.board-stage');
    this.bg = h('img.board-bg', { alt: '', draggable: false });
    this.grid = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.grid.classList.add('board-grid');
    this.hlLayer = h('div.layer.highlights');
    this.tokenLayer = h('div.layer.tokens');
    this.hpLayer = h('div.layer.hpbars'); // above every token, so no token can cover an HP bar
    this.fxLayer = h('div.layer.fx-layer'); // not .fx: that's the floating-text style (fades out)
    this.stage.append(this.bg, this.grid, this.hlLayer, this.tokenLayer, this.hpLayer, this.fxLayer);
    this.viewport.append(this.stage);
    this.empty = h('div.board-empty.hidden');
    const zoomCenter = (f) => this.zoomBy(f, this.viewport.clientWidth / 2, this.viewport.clientHeight / 2);
    this.zoomBar = h('div.board-zoom', {},
      h('button', { title: 'Zoom in', onclick: () => zoomCenter(1.2) }, '+'),
      h('button', { title: 'Zoom out', onclick: () => zoomCenter(1 / 1.2) }, '−'),
      h('button', { title: 'Fit to screen', onclick: () => { this.autoFit = true; this.fit(); } }, 'Fit'));
    root.append(this.viewport, this.empty, this.zoomBar);

    this.bg.addEventListener('load', () => this.layout());
    new ResizeObserver(() => (this.autoFit ? this.fit() : this.applyCamera())).observe(this.viewport);
    this.bindNavigation();
    this.stage.addEventListener('click', (e) => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (e.target.closest('.token')) return;
      const cell = this.cellAt(e.clientX, e.clientY);
      if (cell) this.opts.onCellClick?.(cell, e);
    });
    this.stage.addEventListener('pointermove', (e) => {
      if (!this.opts.onCellHover || this.drag) return;
      this.opts.onCellHover(this.cellAt(e.clientX, e.clientY), e);
    });
    if (this.opts.onPing) this.bindPing();
  }

  // Map navigation (Roll20-style). Trackpad: two-finger scroll pans, pinch zooms toward the
  // gesture. Mouse: the wheel zooms toward the cursor, right- (or middle-) drag pans. Touch: one
  // finger on the empty map pans, two fingers pinch. Gestures over the map never scroll or zoom
  // the page; everywhere else the browser behaves normally.
  bindNavigation() {
    const vp = this.viewport;
    const local = (e) => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const wheelMemory = {};
    vp.addEventListener('wheel', (e) => {
      if (!this.scene) return;
      e.preventDefault();
      const intent = wheelIntent(e, wheelMemory, e.timeStamp);
      if (intent === 'pan') {
        const { dx, dy } = normalizeWheel(e, vp.clientHeight);
        // Shift+wheel on a mouse scrolls sideways, like a page.
        this.panBy(e.shiftKey && !dx ? -dy : -dx, e.shiftKey && !dx ? 0 : -dy);
      } else {
        const p = local(e);
        this.zoomBy(wheelZoomFactor(e, intent, vp.clientHeight), p.x, p.y);
      }
    }, { passive: false });

    // Safari reports trackpad pinches as gesture events (scale relative to the gesture start).
    let gestureScale = 1;
    vp.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
    vp.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const p = local(e);
      this.zoomBy(pinchScaleFactor(e.scale / gestureScale), p.x, p.y);
      gestureScale = e.scale;
    });
    vp.addEventListener('gestureend', (e) => e.preventDefault());

    // Drag-to-pan: right or middle mouse button anywhere on the map; touch on the empty map
    // (a touch on a token drags the token, which stops the event before it gets here).
    const touches = new Map(); // pointerId -> {x, y} for active touch pointers
    let pan = null;
    vp.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, local(e));
        if (touches.size === 2) pan = { pinch: this.pinchState(touches), moved: true };
        else if (touches.size === 1) pan = { x: e.clientX, y: e.clientY, moved: false, touch: true };
        return;
      }
      if (e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      pan = { x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId };
      vp.setPointerCapture(e.pointerId);
      vp.classList.add('panning');
    });
    vp.addEventListener('pointermove', (e) => {
      if (!pan) return;
      if (e.pointerType === 'touch') {
        if (!touches.has(e.pointerId)) return;
        touches.set(e.pointerId, local(e));
        if (pan.pinch && touches.size >= 2) {
          const now = this.pinchState(touches);
          this.zoomBy(now.dist / pan.pinch.dist, now.mid.x, now.mid.y);
          this.panBy(now.mid.x - pan.pinch.mid.x, now.mid.y - pan.pinch.mid.y);
          pan.pinch = now;
          return;
        }
      } else if (e.pointerId !== pan.pointerId) return;
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      pan.moved = true;
      this.panBy(dx, dy);
      pan.x = e.clientX;
      pan.y = e.clientY;
    });
    const end = (e) => {
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (pan?.moved) this.suppressClick = true; // the lift after a pan isn't a tap
        if (touches.size === 1) {
          const [p] = touches.values();
          const r = vp.getBoundingClientRect();
          pan = { x: p.x + r.left, y: p.y + r.top, moved: true, touch: true };
        } else if (!touches.size) pan = null;
        return;
      }
      if (pan && e.pointerId === pan.pointerId) {
        pan = null;
        vp.classList.remove('panning');
      }
    };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
    // Right-drag pans, so the browser menu never opens over the map (or on a touch long-press).
    vp.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pinchState(touches) {
    const [a, b] = [...touches.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  // Press and hold (without moving) anywhere on the map to ping it. Capture-phase listeners, so
  // holding on a token works too (tokens stop pointerdown from bubbling). The click that follows
  // the release is swallowed, so a ping never also selects, opens a menu or picks a target.
  bindPing() {
    let hold = null;
    const cancel = () => { if (hold) clearTimeout(hold.timer); hold = null; };
    this.stage.addEventListener('pointerdown', (e) => {
      cancel();
      this.pinged = false; // a new press: forget the previous ping
      this.suppressClick = false;
      if (e.button !== 0 || !e.isPrimary) return;
      // Anywhere on the map image counts, not just the grid (backgrounds often extend past it).
      const point = this.pointAt(e.clientX, e.clientY, { onGrid: false });
      if (!point) return;
      hold = {
        x: e.clientX, y: e.clientY,
        timer: setTimeout(() => {
          hold = null;
          this.pinged = true;
          this.suppressClick = true;
          this.opts.onPing(point);
        }, PING_HOLD_MS),
      };
    }, true);
    this.stage.addEventListener('pointermove', (e) => {
      if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) >= DRAG_THRESHOLD) cancel();
    }, true);
    // Not pointerleave: a token capturing the pointer on press fires one on its inner element.
    for (const ev of ['pointerup', 'pointercancel']) this.stage.addEventListener(ev, cancel, true);
  }

  showEmpty(text) {
    this.empty.textContent = text;
    this.empty.classList.toggle('hidden', !text);
    this.viewport.classList.toggle('hidden', !!text);
    this.zoomBar.classList.toggle('hidden', !!text);
  }

  get cell() { return this.scene?.grid.cellSize ?? 64; }

  setScene(scene) {
    const key = scene ? JSON.stringify([scene.id, scene.background, scene.bgScale, scene.grid]) : null;
    if (key === this.sceneKey) return;
    const firstForScene = scene?.id !== this.scene?.id;
    this.sceneKey = key;
    this.scene = scene;
    if (!scene) return;
    if (scene.background) {
      if (this.bg.getAttribute('src') !== scene.background) this.bg.src = scene.background;
      this.bg.classList.remove('hidden');
    } else {
      this.bg.removeAttribute('src');
      this.bg.classList.add('hidden');
    }
    this.drawGrid();
    this.layout();
    if (firstForScene) this.autoFit = true;
    if (this.autoFit) this.fit();
  }

  layout() {
    if (!this.scene) return;
    const g = this.scene.grid;
    const s = this.scene.bgScale || 1;
    const bw = this.bg.naturalWidth && this.scene.background ? this.bg.naturalWidth * s : 0;
    const bh = this.bg.naturalHeight && this.scene.background ? this.bg.naturalHeight * s : 0;
    if (bw) { this.bg.style.width = `${bw}px`; this.bg.style.height = `${bh}px`; }
    this.width = Math.max(bw, g.offsetX + g.cols * g.cellSize, 1);
    this.height = Math.max(bh, g.offsetY + g.rows * g.cellSize, 1);
    this.stage.style.width = `${this.width}px`;
    this.stage.style.height = `${this.height}px`;
    if (this.autoFit) this.fit();
    else this.applyCamera();
  }

  // Current zoom (world px -> screen px). Hit testing divides by it.
  get zoom() { return this.cam.zoom; }

  fit() {
    const cam = fitCamera(this.viewport.clientWidth, this.viewport.clientHeight, this.width, this.height);
    if (!cam) return;
    this.cam = cam;
    this.applyCamera();
  }

  // Zoom by `factor` around viewport point (px, py), which stays put on the map.
  zoomBy(factor, px, py) {
    if (!this.width || !Number.isFinite(factor) || factor <= 0) return;
    this.autoFit = false;
    this.cam = zoomAt(this.cam, factor, px, py);
    this.applyCamera();
  }

  panBy(dx, dy) {
    if (!this.width || (!dx && !dy)) return;
    this.autoFit = false;
    this.cam = { ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy };
    this.applyCamera();
  }

  applyCamera() {
    if (this.width) this.cam = clampPan(this.cam, this.viewport.clientWidth, this.viewport.clientHeight, this.width, this.height);
    const { x, y, zoom } = this.cam;
    this.stage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  }

  drawGrid() {
    const g = this.scene.grid;
    const w = g.cols * g.cellSize, hgt = g.rows * g.cellSize;
    const svg = this.grid;
    svg.setAttribute('width', w);
    svg.setAttribute('height', hgt);
    svg.style.left = `${g.offsetX}px`;
    svg.style.top = `${g.offsetY}px`;
    let d = '';
    for (let x = 0; x <= g.cols; x++) d += `M${x * g.cellSize} 0V${hgt}`;
    for (let y = 0; y <= g.rows; y++) d += `M0 ${y * g.cellSize}H${w}`;
    svg.innerHTML = `<path d="${d}" stroke="${g.color ?? '#fff'}" stroke-opacity="${g.opacity ?? 0.25}" stroke-width="1" fill="none"/>`;
    if (this.scene.spawn !== undefined && this.opts.showSpawn) {
      const sp = this.scene.spawn ?? { x: 0, y: g.rows - 1 };
      svg.innerHTML += `<rect class="spawn-mark" x="${sp.x * g.cellSize + 3}" y="${sp.y * g.cellSize + 3}" width="${g.cellSize - 6}" height="${g.cellSize - 6}" rx="6"/>
        <text class="spawn-text" x="${(sp.x + 0.5) * g.cellSize}" y="${(sp.y + 0.5) * g.cellSize}" text-anchor="middle" dominant-baseline="central" font-size="${g.cellSize * 0.24}">SPAWN</text>`;
    }
  }

  placeRect(el, x, y, w = 1, hgt = 1) {
    const g = this.scene.grid, c = g.cellSize;
    el.style.left = `${g.offsetX + x * c}px`;
    el.style.top = `${g.offsetY + y * c}px`;
    el.style.width = `${w * c}px`;
    el.style.height = `${hgt * c}px`;
  }

  // Fractional grid position (in cells) under a screen point. Null off the grid, or with
  // onGrid: false, null only off the map (stage) itself.
  pointAt(clientX, clientY, { onGrid = true } = {}) {
    if (!this.scene) return null;
    const r = this.stage.getBoundingClientRect();
    const g = this.scene.grid;
    const sx = (clientX - r.left) / this.zoom, sy = (clientY - r.top) / this.zoom;
    if (sx < 0 || sy < 0 || sx > this.width || sy > this.height) return null;
    const x = (sx - g.offsetX) / g.cellSize, y = (sy - g.offsetY) / g.cellSize;
    if (onGrid && (x < 0 || y < 0 || x >= g.cols || y >= g.rows)) return null;
    return { x, y };
  }

  cellAt(clientX, clientY) {
    const p = this.pointAt(clientX, clientY);
    return p && { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  // All tokens whose footprint covers the cell, topmost first (by global z).
  stackAt(cell) {
    return this.tokens
      .filter((t) => t.position && cell.x >= t.position.x && cell.x < t.position.x + t.size.w && cell.y >= t.position.y && cell.y < t.position.y + t.size.h)
      .sort((a, b) => b.z - a.z);
  }

  highlight(cells = [], cls = 'move') {
    this.hlLayer.replaceChildren();
    if (!this.scene) return;
    for (const c of cells) {
      const el = h(`div.hl.${cls}`);
      this.placeRect(el, c.x, c.y);
      this.hlLayer.append(el);
    }
  }

  setTokens(tokens, view = {}) {
    this.tokens = tokens;
    this.view = view;
    if (this.drag) { this.pendingRender = true; return; }
    this.renderTokens();
  }

  renderTokens() {
    this.pendingRender = false;
    this.tokenLayer.replaceChildren();
    this.hpLayer.replaceChildren();
    if (!this.scene) return;
    const c = this.cell;
    const v = this.view;
    const stacks = new Map();
    for (const t of this.tokens) {
      if (!t.position) continue;
      const k = `${t.position.x},${t.position.y}`;
      stacks.set(k, (stacks.get(k) ?? 0) + 1);
    }
    for (const t of this.tokens) {
      if (!t.position) continue;
      const mine = v.myId === t.id;
      const el = h(`div.token.kind-${t.kind}.status-${t.status ?? 'active'}`, { dataset: { id: t.id } });
      this.placeRect(el, t.position.x, t.position.y, t.size.w, t.size.h);
      // Players always see their own token on top; everyone else sees the shared global z-order.
      const z = mine ? 1_000_000 : t.z;
      el.style.zIndex = z;
      if (mine) el.classList.add('mine');
      if (v.selectedId === t.id) el.classList.add('selected');
      if (v.targetIds?.has(t.id)) el.classList.add('targetable');
      if (v.targetIds && !v.targetIds.has(t.id) && !mine) el.classList.add('dimmed');
      if (t.color) el.style.setProperty('--ring', t.color);
      const big = t.size.w > 1 || t.size.h > 1;
      const body = h(`div.token-body${big ? '.big' : ''}`);
      if (t.image) body.append(h('img', { src: t.image, alt: t.name, draggable: false }));
      else body.append(h('div.token-fallback', {}, t.icon ?? (t.name || '?').slice(0, 2)));
      if (t.status === 'down') body.append(h('div.token-badge.down', {}, 'DOWN'));
      if (t.status === 'dead') body.append(h('div.token-badge.dead', {}, '☠'));
      el.append(body);
      const stack = stacks.get(`${t.position.x},${t.position.y}`);
      if (t.effects?.length) {
        el.append(h('div.effect-icons', {}, ...t.effects.slice(0, 5).map((fx) => h('span', { title: `${fx.label}${fx.source ? ` (from ${fx.source})` : ''}` }, fx.icon || '✦'))));
      }
      if (t.immortal) el.append(h('div.dummy-badge', { title: `Training dummy: ${t.damageTaken ?? 0} damage over ${t.hits ?? 0} hits` }, `Σ ${t.damageTaken ?? 0}`));
      if (t.actionsLeft !== null && t.actionsLeft !== undefined) {
        el.append(h(`div.action-badge${t.actionsLeft ? '' : '.spent'}`, { title: `${t.actionsLeft} action(s) left this phase` }, `⚡${t.actionsLeft}`));
      }
      if (stack > 1 && v.showStacks) el.append(h('div.stack-count', { title: 'Stacked tokens — click to inspect' }, `×${stack}`));
      if (t.label !== false) el.append(h('div.token-name', {}, t.name));

      const donut = v.donut && v.donut.forId === t.id ? v.donut : null;
      let ringOuter = 0;
      if (donut) {
        const ring = Math.max(22, c * 0.42);
        ringOuter = ring + 2;
        el.classList.add('has-donut');
        el.append(buildDonut({
          tokenSize: Math.min(t.size.w, t.size.h) * c, ring,
          disabled: donut.disabled, active: donut.active, down: t.status === 'down', dead: t.status === 'dead',
          onSegment: (seg, e, off) => donut.onSegment?.(seg, t, e, off),
          onRoll: (e) => donut.onRoll?.(t, e),
        }));
      }
      if (t.hp !== undefined && t.hp !== null && t.maxHp) {
        const pct = Math.max(0, Math.min(1, t.hp / t.maxHp));
        const bar = h('div.hpbar', {},
          h('div.hpfill', { style: { width: `${pct * 100}%` } }),
          h('span.hptext', {}, `${t.hp}/${t.maxHp}`));
        bar.classList.add(t.hp < 0 ? 'neg' : pct > 0.5 ? 'ok' : pct > 0.25 ? 'warn' : 'bad');
        bar.style.top = `${-ringOuter - 16}px`;
        // The bar lives in hpLayer on an anchor matching the token's rect; drags move both.
        const anchor = h('div.hp-anchor', {}, bar);
        this.placeRect(anchor, t.position.x, t.position.y, t.size.w, t.size.h);
        anchor.style.zIndex = z;
        el._hpAnchor = anchor;
        this.hpLayer.append(anchor);
      }
      this.bindToken(el, t);
      this.tokenLayer.append(el);
    }
  }

  bindToken(el, t) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const canDrag = this.opts.canDrag?.(t);
      this.drag = { t, el, startX: e.clientX, startY: e.clientY, moved: false, canDrag, pointerId: e.pointerId };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.t !== t) return;
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.canDrag) return;
      d.moved = true;
      el.classList.add('dragging');
      el.style.transform = `translate(${dx / this.zoom}px, ${dy / this.zoom}px)`;
      if (el._hpAnchor) el._hpAnchor.style.transform = el.style.transform;
    });
    const end = (e, cancelled) => {
      const d = this.drag;
      if (!d || d.t !== t) return;
      this.drag = null;
      el.classList.remove('dragging');
      el.style.transform = '';
      if (el._hpAnchor) el._hpAnchor.style.transform = '';
      if (d.moved && !cancelled) {
        // Drop by the token's top-left cell (keeps large tokens anchored where you grabbed them).
        const c = this.cell * this.zoom;
        const x = t.position.x + Math.round((e.clientX - d.startX) / c);
        const y = t.position.y + Math.round((e.clientY - d.startY) / c);
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; });
        if (x !== t.position.x || y !== t.position.y) this.opts.onTokenDrop?.(t, x, y, e);
      } else if (this.pinged) {
        this.pinged = false; // the hold was a ping, not a click
      } else if (!cancelled) {
        const cell = this.cellAt(e.clientX, e.clientY) ?? t.position;
        this.opts.onTokenClick?.(t, e, this.stackAt(cell));
      }
      if (this.pendingRender) this.renderTokens();
    };
    el.addEventListener('pointerup', (e) => end(e, false));
    el.addEventListener('pointercancel', (e) => end(e, true));
  }

  tokenCenter(id) {
    const t = this.tokens.find((x) => x.id === id);
    if (!t?.position || !this.scene) return null;
    const g = this.scene.grid, c = g.cellSize;
    return { x: g.offsetX + (t.position.x + t.size.w / 2) * c, y: g.offsetY + (t.position.y + t.size.h / 2) * c };
  }

  // Floating combat text (-8, +5, MISS, CRIT) in the attacker's color.
  showFx(entityId, text, color, kind = 'damage') {
    const p = this.tokenCenter(entityId);
    if (!p) return;
    const el = h(`div.fx.fx-${kind}`, { style: { left: `${p.x}px`, top: `${p.y - this.cell * 0.4}px`, color: color || '#fff' } }, text);
    if (kind === 'crit') el.style.top = `${p.y - this.cell * 0.9}px`;
    this.fxLayer.append(el);
    setTimeout(() => el.remove(), 1600);
  }

  // A map ping: a dot plus three rings that grow and fade, in the pinger's color.
  showPing({ sceneId, x, y, color }) {
    if (!this.scene || sceneId !== this.scene.id) return;
    const g = this.scene.grid;
    const el = h('div.ping', {
      style: { left: `${g.offsetX + x * g.cellSize}px`, top: `${g.offsetY + y * g.cellSize}px`, '--ping-color': color || '#fff', '--cell': `${g.cellSize}px` },
    }, h('span.ping-dot'), h('span.ping-ring'), h('span.ping-ring'), h('span.ping-ring'));
    this.fxLayer.append(el);
    setTimeout(() => el.remove(), 2200);
  }

  // Screen position of a token (for anchoring popup menus).
  screenPoint(id) {
    const p = this.tokenCenter(id);
    if (!p) return { x: innerWidth / 2, y: innerHeight / 2 };
    const r = this.stage.getBoundingClientRect();
    return { x: r.left + p.x * this.zoom, y: r.top + p.y * this.zoom };
  }
}
