import { io } from '/socket.io/socket.io.esm.min.js';
import { $, fill, h, toast, sendCmd, popupMenu, closeMenu, combatBar, ROLE_LABELS, ROLE_ICONS, PLAYER_COLORS } from './common.js';
import { Board } from './board.js';
import { SidePanel } from './panel.js';

const token = decodeURIComponent(location.pathname.split('/').pop());
const SEAT_KEY = `dne:seat:${token}`;
const NAME_KEY = 'dne:name';

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let content = await fetch('/api/content/public').then((r) => r.json());
let heroById = new Map(content.characters.map((c) => [c.id, c]));

let seat = store.get(SEAT_KEY);
let state = null;
let pickedRole = null;
let mode = null; // null | {type:'move'} | {type:'target', ...}
let fatal = null;

const socket = io('/play', { auth: { joinToken: token, playerId: seat?.playerId, seatSecret: seat?.seatSecret } });
const panel = new SidePanel($('#panel'), {
  onSend: (text) => new Promise((r) => socket.emit('chat', text, (res) => { if (!res?.ok) toast(res?.error ?? 'Failed', 'error'); r(); })),
});
const bar = combatBar($('#combat-bar'));

socket.on('state', (s) => { state = s; render(); });
socket.on('history', (hist) => panel.setHistory(hist));
socket.on('chat', (rows) => panel.addChat(rows));
socket.on('activity', (rows) => panel.addActivity(rows));
socket.on('fx', (list) => { for (const f of list) board.showFx(f.entityId, f.text, f.color, f.kind); });
socket.on('seatInvalid', () => {
  store.del(SEAT_KEY);
  seat = null;
  socket.auth = { joinToken: token };
  toast('Your seat was reset by the DM. Please join again.');
});
socket.on('fatal', (msg) => { fatal = msg; render(); });
// The DM edited heroes/acts or art: refetch so the hero picker and Act menu stay current.
socket.on('contentChanged', async () => {
  content = await fetch('/api/content/public').then((r) => r.json());
  heroById = new Map(content.characters.map((c) => [c.id, c]));
  render();
});
socket.on('connect_error', () => toast('Connection problem — retrying…', 'error'));

const send = (cmd) => sendCmd(socket, cmd);

// ---------- board ----------

const board = new Board($('#board'), {
  canDrag: (t) => t.id === myEntity()?.id && !mode,
  onTokenDrop: (t, x, y) => send({ type: 'move', entityId: t.id, x, y }),
  onTokenClick: (t, e, stack) => onTokenClick(t, e, stack),
  onCellClick: (cell) => onCellClick(cell),
});

function myEntity() {
  return state?.entities.find((e) => e.id === state.me?.entityId) ?? null;
}

const playerColor = (pid) => state.players.find((p) => p.id === pid)?.color;
const dist = (a, sa, b, sb) => {
  const dx = Math.max(0, b.x - (a.x + sa.w - 1), a.x - (b.x + sb.w - 1));
  const dy = Math.max(0, b.y - (a.y + sa.h - 1), a.y - (b.y + sb.h - 1));
  return Math.max(dx, dy);
};

function availability() {
  const me = myEntity();
  const c = state.combat;
  const t = state.turn ?? { actions: 0, bonus: 0, moved: 0 };
  const actionsLeft = Math.max(0, (me.actionsPerPhase ?? 1) + t.bonus - t.actions);
  const actionLeft = !c.active || actionsLeft > 0;
  const dmPhase = c.active && c.phase !== 'player';
  const moveLeft = c.active ? Math.max(0, me.movement - t.moved) : Infinity;
  return { me, c, t, actionLeft, actionsLeft, dmPhase, moveLeft, canAct: me.status === 'active' && !dmPhase && actionLeft };
}

function cellsWithin(origin, size, range) {
  const g = state.scene.grid, out = [];
  for (let y = 0; y < g.rows; y++) for (let x = 0; x < g.cols; x++) {
    if (dist(origin, size, { x, y }, { w: 1, h: 1 }) <= range) out.push({ x, y });
  }
  return out;
}

function renderBoard() {
  const me = myEntity();
  board.setScene(state.scene);
  const tokens = state.entities.map((e) => ({ ...e, color: e.kind === 'pc' ? playerColor(e.ownerPlayerId) : e.hostile ? '#8a2f2f' : '#d4af37' }));
  const view = { myId: me?.id, showStacks: true };
  if (me && !mode) {
    const a = availability();
    const disabled = new Set();
    if (!a.c.active || !a.canAct) disabled.add('attack');
    if (a.dmPhase || a.moveLeft === 0) disabled.add('move');
    if (!a.canAct) { disabled.add('inventory'); disabled.add('act'); }
    view.donut = { forId: me.id, disabled, onSegment, onRoll: () => send({ type: 'downRoll', entityId: me.id }) };
  }
  if (mode?.type === 'target') {
    view.targetIds = new Set(state.entities.filter((e) => mode.filter(e) && e.status !== 'dead'
      && dist(me.position, me.size, e.position, e.size) <= mode.range).map((e) => e.id));
    board.highlight(cellsWithin(me.position, me.size, mode.range), 'range');
  } else if (mode?.type === 'move') {
    const a = availability();
    board.highlight(a.c.active ? cellsWithin(me.position, me.size, a.moveLeft) : [], 'move');
  } else {
    board.highlight([]);
  }
  board.setTokens(tokens, view);
  renderModeBanner();
}

function renderModeBanner() {
  $('.mode-banner')?.remove();
  if (!mode) return;
  $('#board').append(h('div.mode-banner', {}, mode.label, h('button.small', { onclick: cancelMode }, 'Cancel (Esc)')));
}

function setMode(m) {
  mode = m;
  closeMenu();
  renderBoard();
}
function cancelMode() { setMode(null); }
addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelMode(); });

function onCellClick(cell) {
  const me = myEntity();
  if (mode?.type === 'move') {
    send({ type: 'move', entityId: me.id, x: cell.x, y: cell.y }).then((ok) => { if (ok) cancelMode(); });
  }
}

function onTokenClick(t, e, stack) {
  if (mode?.type === 'target') {
    const target = stack.find((s) => mode.filter(s) && s.status !== 'dead') ?? t;
    const me = myEntity();
    if (!mode.filter(target) || target.status === 'dead') return toast('Not a valid target', 'error');
    if (dist(me.position, me.size, target.position, target.size) > mode.range) return toast(`${target.name} is out of range`, 'error');
    const m = mode;
    cancelMode();
    m.onTarget(target);
    return;
  }
  if (mode?.type === 'move') return onCellClick(board.cellAt(e.clientX, e.clientY));
  if (stack.length > 1) {
    popupMenu(e.clientX, e.clientY, 'Here', stack.map((s) => ({ label: s.name, sub: s.status !== 'active' ? s.status.toUpperCase() : s.kind === 'pc' ? 'hero' : '' })));
  }
}

const isFoe = (me) => (e) => e.id !== me.id;
const isFriend = (e) => e.kind === 'pc' || (e.kind === 'npc' && !e.hostile);

function onSegment(seg, t, e) {
  const a = availability();
  const at = board.screenPoint(t.id);
  const why = a.me.status !== 'active' ? `${a.me.name} is ${a.me.status}` : a.dmPhase ? 'Wait for the PLAYER PHASE' : !a.actionLeft ? 'Action already used this phase' : null;
  if (seg === 'move') {
    if (a.dmPhase) return toast('Wait for the PLAYER PHASE', 'error');
    if (a.moveLeft === 0) return toast('No movement left this phase', 'error');
    return setMode({ type: 'move', label: a.c.active ? `Move up to ${a.moveLeft} squares — click a square` : 'Click a square to move (or drag your token)' });
  }
  if (seg === 'attack') {
    const note = !a.c.active ? 'Attacks unlock when combat begins' : why;
    popupMenu(at.x + 60, at.y - 60, note ? `Attack — ${note}` : 'Attack', a.me.attacks.map((atk) => ({
      label: atk.name,
      sub: `${atk.attack} to hit · ${atk.damage} dmg · range ${atk.range ?? 1}`,
      disabled: !!note,
      onClick: () => setMode({
        type: 'target', label: `${atk.name}: choose a target`, range: Number(atk.range) || 1, filter: isFoe(a.me),
        onTarget: (target) => send({ type: 'attack', entityId: a.me.id, attackId: atk.id, targetId: target.id }),
      }),
    })));
    return;
  }
  if (seg === 'inventory') {
    const items = a.me.inventory.map((it) => ({
      label: it.name, sub: a.c.active ? 'Use (costs your action)' : 'Use', disabled: !!why,
      onClick: () => send({ type: 'item.use', entityId: a.me.id, itemId: it.id }),
    }));
    popupMenu(at.x + 60, at.y + 20, why ? `Inventory — ${why}` : 'Inventory', items.length ? items : [{ label: 'Empty', disabled: true }]);
    return;
  }
  if (seg === 'act') {
    const items = [];
    if (a.me.abilities.length) items.push({ heading: 'Abilities' });
    for (const ab of a.me.abilities) {
      const free = ab.free || ab.grantsActions;
      const used = ab.grantsActions && a.t.abilitiesUsed?.includes(ab.id);
      const blocked = a.me.status !== 'active' || a.dmPhase || (!free && !a.actionLeft) || used;
      items.push({
        label: ab.name,
        sub: [ab.description, ab.heal ? `heals ${ab.heal}, range ${ab.range || 1}` : ab.roll ? `roll ${ab.roll}` : '', free && a.c.active ? 'free' : ''].filter(Boolean).join(' · '),
        disabled: blocked,
        onClick: () => {
          if (ab.heal) {
            return setMode({
              type: 'target', label: `${ab.name}: choose an ally`, range: Number(ab.range) || 1, filter: (x) => isFriend(x),
              onTarget: (target) => send({ type: 'ability', entityId: a.me.id, abilityId: ab.id, targetId: target.id }),
            });
          }
          send({ type: 'ability', entityId: a.me.id, abilityId: ab.id });
        },
      });
    }
    items.push({ heading: 'Actions' });
    for (const act of content.acts) {
      items.push({ label: act.name, sub: act.roll ? `roll ${act.roll}` : '', disabled: !!why, onClick: () => send({ type: 'act', entityId: a.me.id, actId: act.id }) });
    }
    const input = h('input', { placeholder: 'Something else… (e.g. Pull the rope)', maxLength: 80 });
    const roll = h('select', {}, ...['', '1d20', '1d12', '1d10', '1d8', '1d6', '1d4'].map((r) => h('option', { value: r }, r || 'no roll')));
    const form = h('form', {
      onsubmit: (ev) => {
        ev.preventDefault();
        if (!input.value.trim()) return;
        send({ type: 'act', entityId: a.me.id, text: input.value, roll: roll.value || null });
        closeMenu();
      },
    }, input, roll, h('button.small.primary', { type: 'submit', disabled: !!why }, 'Do it'));
    items.push({ heading: 'Custom' }, { node: form });
    popupMenu(at.x - 340, at.y - 80, why ? `Act — ${why}` : 'Act', items);
  }
}

// ---------- screens ----------

function showFlow(...nodes) {
  $('#game').classList.add('hidden');
  const flow = $('#flow');
  flow.classList.remove('hidden');
  fill(flow, ...nodes);
}

function nameScreen() {
  const remembered = store.get(NAME_KEY);
  const input = h('input.big-input', { placeholder: 'Your name', maxLength: 24, value: remembered ?? '', autofocus: true });
  const join = (name) => {
    name = String(name ?? '').trim();
    if (!name) return toast('Enter a name', 'error');
    socket.emit('join', { name }, (res) => {
      if (!res?.ok) return toast(res?.error ?? 'Could not join', 'error');
      seat = { playerId: res.playerId, seatSecret: res.seatSecret };
      store.set(SEAT_KEY, seat);
      store.set(NAME_KEY, name);
      socket.auth = { joinToken: token, ...seat };
    });
  };
  showFlow(
    h('h1', {}, state?.game?.name ?? 'One & Done'),
    h('h2', {}, "What's your name?"),
    remembered ? h('p', {}, h('button.gold', { onclick: () => join(remembered) }, `Continue as ${remembered}`)) : null,
    h('form', { onsubmit: (e) => { e.preventDefault(); join(input.value); } },
      input, h('p', {}, h('button.primary', { type: 'submit' }, remembered ? 'Use this name' : 'Join'))));
  setTimeout(() => input.focus());
}

function roleScreen() {
  const taken = state.takenCharacters;
  showFlow(
    h('h1', {}, `Welcome, ${state.me.name}`),
    h('h2', {}, 'Choose a role'),
    h('div.role-grid', {}, ...['tank', 'dps', 'heal'].map((r) => {
      const heroes = content.characters.filter((c) => c.role === r);
      const free = heroes.filter((c) => !taken[c.id]).length;
      return h('div.role-card', { onclick: () => { pickedRole = r; render(); } },
        h('div.icon', {}, ROLE_ICONS[r]), h('h2', {}, ROLE_LABELS[r]), h('div.muted', {}, `${free} of ${heroes.length} heroes available`));
    })));
}

function heroScreen() {
  const taken = state.takenCharacters;
  const who = (pid) => state.players.find((p) => p.id === pid)?.name ?? 'someone';
  showFlow(
    h('div.row', {}, h('button', { onclick: () => { pickedRole = null; render(); } }, '← Roles'), h('h1.grow', {}, `Choose your ${ROLE_LABELS[pickedRole]}`)),
    h('div.hero-grid', {}, ...content.characters.filter((c) => c.role === pickedRole).map((c) => {
      const takenBy = taken[c.id];
      return h(`div.hero-card${takenBy ? '.taken' : ''}`, {
        onclick: () => { if (!takenBy) send({ type: 'player.selectCharacter', characterId: c.id }); },
      },
      h('img.portrait', { src: c.image, alt: '' }),
      h('h3', {}, c.name),
      h('div.stats', {}, h('span', {}, '❤ ', h('b', {}, c.maxHp)), h('span', {}, '🛡 ', h('b', {}, c.defense)), h('span', {}, '👣 ', h('b', {}, c.movement))),
      h('div.section-title', {}, 'Attacks'),
      h('ul', {}, ...c.attacks.map((a) => h('li', {}, `${a.name} — ${a.damage}, range ${a.range ?? 1}`))),
      c.abilities?.length ? h('div.section-title', {}, 'Abilities') : null,
      c.abilities?.length ? h('ul', {}, ...c.abilities.map((a) => h('li', {}, a.name + (a.description ? ` — ${a.description}` : '')))) : null,
      takenBy ? h('div.muted', { style: { textAlign: 'center' } }, `Taken by ${who(takenBy)}`) : h('button.primary', {}, 'Play this hero'));
    })));
}

function waitingScreen() {
  const hero = heroById.get(state.me.characterId);
  showFlow(
    h('div.waiting', {}, h('span.spinner', {}, '⏳'), 'Waiting for DM to set active scene'),
    h('p.muted', {}, `You are playing ${hero?.name ?? state.me.characterId}. Hang tight!`),
    h('p', {}, meChip()));
}

function meChip() {
  const me = state.me;
  return h('span.me-chip', { onclick: (e) => settingsMenu(e) }, h('span.dot', { style: { background: me.color } }), me.name, ' ⚙');
}

function settingsMenu(e) {
  const me = state.me;
  const used = new Map(state.players.filter((p) => p.id !== me.id).map((p) => [p.color, p.name]));
  const nameInput = h('input', { value: me.name, maxLength: 24 });
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (await send({ type: 'player.setName', name: nameInput.value })) {
        store.set(NAME_KEY, nameInput.value.trim());
        closeMenu();
      }
    },
  }, nameInput, h('button.small.primary', { type: 'submit' }, 'Rename'));
  const swatches = h('div.swatches', {}, ...PLAYER_COLORS.map((c) => h(`button.swatch${c === me.color ? '.current' : ''}`, {
    style: { background: c }, disabled: used.has(c), title: used.has(c) ? `Taken by ${used.get(c)}` : 'Pick this color',
    onclick: () => send({ type: 'player.setColor', color: c }).then(() => closeMenu()),
  })));
  popupMenu(e.clientX - 150, e.clientY + 16, 'You', [{ heading: 'Name' }, { node: form }, { heading: 'Color' }, { node: swatches }]);
}

function gameScreen() {
  $('#flow').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#game-name').textContent = state.game.name;
  $('#me-chip').replaceWith(Object.assign(meChip(), { id: 'me-chip' }));
  bar.update(state.combat, state.serverNow);
  const me = myEntity();
  const info = $('#turn-info');
  if (me && state.combat.active) {
    const a = availability();
    info.textContent = me.status !== 'active' ? me.status.toUpperCase()
      : `Actions: ${a.actionsLeft}/${(me.actionsPerPhase ?? 1) + (a.t.bonus ?? 0)} · Move: ${a.moveLeft}/${me.movement}`;
  } else info.textContent = me?.status && me.status !== 'active' ? me.status.toUpperCase() : '';
  // Cancel a pending mode if it no longer makes sense (e.g. phase changed).
  if (mode && (!me || me.status !== 'active' || (state.combat.active && state.combat.phase !== 'player'))) mode = null;
  renderBoard();
}

let lastScreen = null;
function render() {
  if (fatal) return showFlow(h('h1', {}, 'One & Done'), h('h2', {}, fatal));
  if (!state) return;
  const screen = !state.me ? 'name' : !state.me.characterId ? `pick:${pickedRole}` : !state.scene ? 'wait' : 'game';
  const same = screen === lastScreen;
  lastScreen = screen;
  // Don't wipe what the player is typing when unrelated state arrives.
  if (screen === 'name') return same ? undefined : nameScreen();
  if (!state.me.characterId) {
    if (!pickedRole) return roleScreen();
    return heroScreen();
  }
  pickedRole = null;
  if (!state.scene) return waitingScreen();
  gameScreen();
}
