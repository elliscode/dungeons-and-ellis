import { io } from '/socket.io/socket.io.esm.min.js';
import { $, fill, $$, h, api, toast, sendCmd, popupMenu, closeMenu, combatBar, copyText, PLAYER_COLORS, ROLE_LABELS } from './common.js';
import { Board } from './board.js';
import { SidePanel } from './panel.js';

const gameId = location.pathname.split('/').pop();
const me = await api('GET', '/api/me');
if (!me.dm) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
let content = await api('GET', '/api/content');
let heroById = new Map(content.characters.map((c) => [c.id, c]));

let state = null;
let selectedId = null;
let mode = null; // {type:'place', kind, def, scope} | {type:'target', attacker, attack}
let spawnScope = 'scene';
let templates = [];

const socket = io('/dm', { auth: { gameId } });
const send = (cmd) => sendCmd(socket, cmd);
const panel = new SidePanel($('#panel'), {
  onSend: (text) => new Promise((r) => socket.emit('chat', text, (res) => { if (!res?.ok) toast(res?.error ?? 'Failed', 'error'); r(); })),
});
const bar = combatBar($('#combat-bar'));

socket.on('state', (s) => { state = s; render(); });
socket.on('history', (hist) => panel.setHistory(hist));
socket.on('chat', (rows) => panel.addChat(rows));
socket.on('activity', (rows) => panel.addActivity(rows));
socket.on('fx', (list) => { for (const f of list) board.showFx(f.entityId, f.text, f.color, f.kind); });
// Definitions or art changed (Data/Assets pages): refresh the banks and hero names.
socket.on('contentChanged', async () => {
  content = await api('GET', '/api/content');
  heroById = new Map(content.characters.map((c) => [c.id, c]));
  memoKeys.banks = memoKeys.players = null;
  loadTemplates();
  if (state) render();
});
socket.on('fatal', (msg) => { toast(msg, 'error'); setTimeout(() => { location.href = '/'; }, 1500); });
socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  else toast('Connection problem — retrying…', 'error');
});

// ---------- helpers ----------

const activeScene = () => (state.activeSceneId ? state.scenes[state.activeSceneId] : null);
const sceneEntities = () => Object.values(state.entities).filter((e) => e.scope === 'game' || e.sceneId === state.activeSceneId);
const playerOf = (e) => state.players.find((p) => p.id === e.ownerPlayerId);
const selected = () => (selectedId ? state.entities[selectedId] : null);

function tokenFor(e) {
  const p = playerOf(e);
  return {
    id: e.id, kind: e.kind, name: e.name, image: e.image, size: e.size, position: e.positions[state.activeSceneId],
    z: e.z, hp: e.hp, maxHp: e.maxHp, status: e.status,
    color: p ? p.color : e.kind === 'monster' || e.hostile ? '#8a2f2f' : '#d4af37',
  };
}

function setMode(m) {
  mode = m;
  closeMenu();
  renderBoard();
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setMode(null); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.target.closest('input')) { e.preventDefault(); undo(); }
});

// ---------- board ----------

const board = new Board($('#board'), {
  canDrag: () => !mode,
  onTokenDrop: (t, x, y) => send({ type: 'move', entityId: t.id, x, y }),
  onCellClick: (cell, e) => {
    if (mode?.type === 'place') return place(cell, e);
    if (mode) return;
    select(null);
  },
  onTokenClick: (t, e, stack) => {
    if (mode?.type === 'place') return place(board.cellAt(e.clientX, e.clientY), e);
    if (mode?.type === 'target') {
      const pick = (target) => {
        const m = mode;
        setMode(null);
        send({ type: 'attack', entityId: m.attacker.id, attackId: m.attack.id, targetId: target.id });
      };
      const candidates = stack.filter((s) => s.id !== mode.attacker.id);
      if (candidates.length > 1) return popupMenu(e.clientX, e.clientY, 'Which target?', candidates.map((s) => ({ label: s.name, onClick: () => pick(s) })));
      return candidates[0] ? pick(candidates[0]) : null;
    }
    // Stack inspector: tokens underneath the top one are reachable here.
    if (stack.length > 1) {
      return popupMenu(e.clientX, e.clientY, `Stack (${stack.length}) — top first`, stack.map((s) => ({
        label: `${s.id === selectedId ? '● ' : ''}${s.name}`,
        sub: `${s.kind.toUpperCase()} · ${s.hp ?? '?'}/${s.maxHp ?? '?'} HP${s.status !== 'active' ? ` · ${s.status.toUpperCase()}` : ''}`,
        onClick: () => select(s.id),
      })));
    }
    select(t.id);
  },
});

function place(cell, e) {
  if (!cell) return;
  const m = mode;
  if (!e.shiftKey) setMode(null);
  send({ type: 'entity.spawn', kind: m.kind, defId: m.def.id, scope: m.scope, x: cell.x, y: cell.y })
    .then((r) => { if (r?.entityId) select(r.entityId); });
}

function select(id) {
  selectedId = id;
  renderBoard();
  memoKeys.inspector = null;
  renderInspector();
}

function renderBoard() {
  const scene = activeScene();
  if (!scene) {
    board.showEmpty(Object.keys(state.scenes).length ? 'No active scene — pick one on the left (players are waiting).' : 'Add a scene from your library to get started.');
    return;
  }
  board.showEmpty('');
  board.setScene(scene);
  const view = { selectedId, showStacks: true };
  const tokens = sceneEntities().map(tokenFor);
  if (mode?.type === 'target') {
    view.targetIds = new Set(tokens.filter((t) => t.id !== mode.attacker.id && t.status !== 'dead').map((t) => t.id));
    const a = state.entities[mode.attacker.id];
    const pos = a.positions[scene.id];
    const range = Number(mode.attack.range) || 1;
    const cells = [];
    for (let y = 0; y < scene.grid.rows; y++) for (let x = 0; x < scene.grid.cols; x++) {
      const dx = Math.max(0, x - (pos.x + a.size.w - 1), pos.x - x), dy = Math.max(0, y - (pos.y + a.size.h - 1), pos.y - y);
      if (Math.max(dx, dy) <= range) cells.push({ x, y });
    }
    board.highlight(cells, 'range');
  } else board.highlight([]);
  board.setTokens(tokens, view);
  $('.mode-banner')?.remove();
  if (mode) {
    const label = mode.type === 'place'
      ? `Click the map to place ${mode.def.name} (${mode.scope} scope). Shift-click to place several.`
      : `${mode.attacker.name} — ${mode.attack.name}: pick a target`;
    $('#board').append(h('div.mode-banner', {}, label, h('button.small', { onclick: () => setMode(null) }, 'Cancel (Esc)')));
  }
}

// ---------- top bar ----------

function renderTop() {
  $('#game-name').textContent = state.name;
  bar.update(state.combat, state.serverNow);
  const c = state.combat;
  const timer = h('select', {
    title: 'Phase timer',
    onchange: async (e) => {
      let v = e.target.value;
      if (v === 'custom') {
        v = prompt('Seconds per phase (0 = off):', String(c.timerSeconds || 45));
        if (v === null) return renderTop();
      }
      send({ type: 'combat.setTimer', seconds: Number(v) });
    },
  }, ...[[0, '⏱ Off'], [30, '⏱ 30s'], [60, '⏱ 60s'], [90, '⏱ 90s'], [120, '⏱ 120s']].map(([v, l]) => h('option', { value: v, selected: c.timerSeconds === v }, l)),
  ![0, 30, 60, 90, 120].includes(c.timerSeconds) ? h('option', { value: c.timerSeconds, selected: true }, `⏱ ${c.timerSeconds}s`) : null,
  h('option', { value: 'custom' }, 'Custom…'));
  fill($('#combat-controls'), 
    timer,
    c.active
      ? h('button.gold', { onclick: () => send({ type: 'combat.advance' }) }, c.phase === 'player' ? '▶ DM Phase' : '▶ Player Phase')
      : h('button.primary', { onclick: () => send({ type: 'combat.start' }), disabled: !activeScene() }, '⚔️ Start combat'),
    c.active ? h('button.danger', { onclick: () => send({ type: 'combat.end' }) }, 'End combat') : null,
  );
  const u = $('#undo');
  u.disabled = !state.undo;
  u.textContent = state.undo ? `↶ Undo ${state.undo}` : '↶ Undo';
}

$('#copy-link').addEventListener('click', () => copyText(`${location.origin}/g/${state.joinToken}`));
$('#undo').addEventListener('click', undo);
$('#game-name').addEventListener('dblclick', () => {
  const name = prompt('Game name', state.name);
  if (name) send({ type: 'dm.renameGame', name });
});
function undo() {
  if (state?.undo) send({ type: 'undo' }).then((r) => r && toast(`Undid ${r.undone}`));
}

// ---------- sidebar ----------

for (const b of $$('.side-tabs button')) {
  b.addEventListener('click', () => {
    for (const o of $$('.side-tabs button')) o.classList.toggle('active', o === b);
    for (const t of ['scenes', 'players', 'banks']) $(`#tab-${t}`).classList.toggle('hidden', t !== b.dataset.tab);
    if (b.dataset.tab === 'scenes') loadTemplates();
  });
}

async function loadTemplates() {
  templates = await api('GET', '/api/scenes');
  if (state) renderScenes();
}

function renderScenes() {
  const root = $('#tab-scenes');
  const pick = h('select.grow', {}, ...templates.map((t) => h('option', { value: t.id }, t.name)));
  fill(root, 
    h('div.section-title', {}, 'Scenes in this game'),
    ...(state.sceneOrder.length ? state.sceneOrder.map((sid) => {
      const s = state.scenes[sid];
      const active = sid === state.activeSceneId;
      const count = Object.values(state.entities).filter((e) => e.scope === 'scene' && e.sceneId === sid).length;
      return h(`div.scene-item${active ? '.active' : ''}`, {},
        h('span.name', { title: s.name }, `${active ? '▶ ' : ''}${s.name}`),
        h('span.muted', { title: 'Scene-scoped creatures' }, `${count}🐾`),
        active ? null : h('button.small.primary', { onclick: () => send({ type: 'scene.activate', sceneId: sid }) }, 'Go'),
        h('button.small', {
          title: 'Rename', onclick: () => { const n = prompt('Scene name', s.name); if (n) send({ type: 'scene.rename', sceneId: sid, name: n }); },
        }, '✎'),
        h('button.small.danger', {
          title: 'Remove from game',
          onclick: () => confirm(`Remove "${s.name}" from this game? Its scene-scoped creatures go with it. The template is kept.`) && send({ type: 'scene.remove', sceneId: sid }),
        }, '✕'));
    }) : [h('p.muted', {}, 'No scenes yet.')]),
    state.activeSceneId ? h('button.small', { onclick: () => send({ type: 'scene.activate', sceneId: null }) }, 'Clear active scene') : null,
    h('div.section-title', {}, 'Add from library'),
    templates.length
      ? h('div.row', {}, pick, h('button.primary.small', { onclick: () => send({ type: 'scene.add', templateId: pick.value }) }, 'Add'))
      : h('p.muted', {}, 'Your scene library is empty. ', h('a', { href: '/#scenes' }, 'Build a scene'), ' first.'),
    h('p.muted', { style: { fontSize: '12px' } }, 'Each added scene is an independent live copy. Map layout is edited in Scenes, not here.'),
  );
}

function renderPlayers() {
  const root = $('#tab-players');
  fill(root, 
    h('div.section-title', {}, `Players (${state.players.length}/10)`),
    ...(state.players.length ? state.players.map((p) => {
      const hero = p.characterId ? heroById.get(p.characterId) : null;
      return h('div.player-item', {},
        h(`span.presence.${p.presence}`, { title: p.presence }),
        h('button.swatch', {
          style: { background: p.color, width: '18px', height: '18px' }, title: 'Change color',
          onclick: (e) => popupMenu(e.clientX, e.clientY, `${p.name}'s color`, [{
            node: h('div.swatches', {}, ...PLAYER_COLORS.map((c) => h('button.swatch', {
              style: { background: c }, disabled: state.players.some((o) => o.color === c && o.id !== p.id),
              onclick: () => { send({ type: 'dm.setPlayerColor', playerId: p.id, color: c }); closeMenu(); },
            }))),
          }]),
        }),
        h('span.name', {}, h('b', { style: { color: p.color } }, p.name), h('br'), h('span.muted', {}, hero ? `${hero.name} (${ROLE_LABELS[hero.role]})` : 'choosing a hero…')),
        p.entityId ? h('button.small', { title: 'Select token', onclick: () => select(p.entityId) }, '◎') : null,
        h('button.small', {
          title: 'Reset Player / Release Character',
          disabled: !p.characterId,
          onclick: () => confirm(`Release ${hero?.name} from ${p.name}? They will pick a hero again.`) && send({ type: 'dm.resetPlayer', playerId: p.id }),
        }, 'Release'),
        h('button.small.danger', {
          title: 'Remove this seat (the old browser cannot rejoin as this player)',
          onclick: () => confirm(`Remove ${p.name} from the game?`) && send({ type: 'dm.removePlayer', playerId: p.id }),
        }, '✕'));
    }) : [h('p.muted', {}, 'Nobody has joined yet. Share the player link.')]),
    h('button.small', { onclick: () => copyText(`${location.origin}/g/${state.joinToken}`) }, '🔗 Copy player link'),
  );
}

function renderBanks() {
  const root = $('#tab-banks');
  const scopeBtn = (s, label) => h(`button.small${spawnScope === s ? '.active' : ''}`, { onclick: () => { spawnScope = s; renderBanks(); } }, label);
  const bank = (kind, defs) => defs.map((d) => h('div.bank-item', {},
    d.image ? h('img', { src: d.image, alt: '' }) : null,
    h('span.name', {}, d.name, h('br'), h('span.muted', {}, `${d.maxHp} HP · DEF ${d.defense}${d.size ? ` · ${d.size.w}×${d.size.h}` : ''}`)),
    h('button.small.primary', {
      disabled: !activeScene(),
      onclick: () => setMode({ type: 'place', kind, def: d, scope: spawnScope }),
    }, 'Place')));
  const live = activeScene() ? sceneEntities().filter((e) => e.kind !== 'pc') : [];
  fill(root, 
    h('div.section-title', {}, 'Spawn scope'),
    h('div.row', {}, scopeBtn('scene', '📍 Scene (stays here)'), scopeBtn('game', '🧭 Game (follows party)')),
    h('div.section-title', {}, 'NPC bank'), ...bank('npc', content.npcs),
    h('div.section-title', {}, 'Monster bank'), ...bank('monster', content.monsters),
    h('div.section-title', {}, 'Live in this scene'),
    ...(live.length ? live.map((e) => h('div.bank-item', { style: { cursor: 'pointer' }, onclick: () => select(e.id) },
      h('span.name', {}, e.name, ' ', h('span.muted', {}, `${e.hp}/${e.maxHp} ${e.scope === 'game' ? '🧭' : '📍'}${e.status !== 'active' ? ` ${e.status}` : ''}`)))) : [h('p.muted', {}, 'None')]),
  );
}

// ---------- inspector ----------

function renderInspector() {
  const root = $('#inspector');
  const e = selected();
  if (!e || !(e.scope === 'game' || e.sceneId === state.activeSceneId)) {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');
  const id = e.id;
  const amount = h('input', { type: 'number', min: 0, value: 5 });
  const hpInput = h('input', { type: 'number', min: 0, max: e.maxHp, value: e.hp });
  const maxInput = h('input', { type: 'number', min: 1, value: e.maxHp });
  const itemInput = h('input.grow', { placeholder: 'Add item…', maxLength: 60 });
  const owner = playerOf(e);
  const c = state.combat;
  const turn = state.turn[id];
  fill(root, 
    h('h3', {}, e.name, h('button.small', { title: 'Rename', onclick: () => { const n = prompt('Name', e.name); if (n) send({ type: 'entity.rename', entityId: id, name: n }); } }, '✎'),
      h('span.grow'), h('button.small', { onclick: () => select(null), title: 'Close' }, '✕')),
    h('div.row', {},
      h('span.tag', {}, e.kind === 'pc' ? 'player' : e.kind),
      h('span.tag', {}, e.scope === 'game' ? 'game scope' : 'scene scope'),
      h('span.tag', { style: { color: e.status === 'active' ? 'var(--good)' : 'var(--bad)' } }, e.status),
      e.kind !== 'pc' ? h('span.tag', {}, e.hostile ? 'hostile' : 'friendly') : null,
      owner ? h('span.tag', { style: { color: owner.color } }, owner.name) : null),
    h('p', {}, `❤ ${e.hp}/${e.maxHp} · 🛡 DEF ${e.defense} · 👣 ${e.movement}`,
      c.active && turn ? h('span.muted', {}, ` · used ${turn.actions}/${1 + turn.bonus} actions, moved ${turn.moved}`) : null),
    h('div.row', {}, amount,
      h('button.small.danger', { onclick: () => send({ type: 'entity.damage', entityId: id, amount: Number(amount.value) }) }, '− Damage'),
      h('button.small', { onclick: () => send({ type: 'entity.heal', entityId: id, amount: Number(amount.value) }) }, '+ Heal')),
    h('div.row', { style: { marginTop: '6px' } },
      h('label.inline', {}, 'HP', hpInput), h('button.small', { onclick: () => send({ type: 'entity.setHp', entityId: id, hp: Number(hpInput.value) }) }, 'Set'),
      h('label.inline', {}, 'Max', maxInput), h('button.small', { onclick: () => send({ type: 'entity.setMaxHp', entityId: id, maxHp: Number(maxInput.value) }) }, 'Set')),
    h('div.row', { style: { marginTop: '6px' } },
      e.status !== 'active' ? h('button.small.primary', { onclick: () => send({ type: 'entity.revive', entityId: id }) }, '✚ Revive') : null,
      e.status !== 'dead' ? h('button.small.danger', { onclick: () => send({ type: 'entity.kill', entityId: id }) }, '☠ Kill') : null,
      e.status === 'active' && e.kind !== 'monster' ? h('button.small', { onclick: () => send({ type: 'entity.setStatus', entityId: id, status: 'down' }) }, 'Set DOWN') : null,
      c.active ? h('button.small', { onclick: () => send({ type: 'entity.grantAction', entityId: id }) }, '+1 action') : null),
    e.kind !== 'pc' ? h('div.row', { style: { marginTop: '6px' } },
      e.scope === 'scene'
        ? h('button.small', { onclick: () => send({ type: 'entity.setScope', entityId: id, scope: 'game' }), title: 'Promote: follows the party between scenes' }, '🧭 Make game-scoped')
        : h('button.small', { onclick: () => send({ type: 'entity.setScope', entityId: id, scope: 'scene' }), title: 'Demote: stays in this scene' }, '📍 Leave in this scene'),
      e.kind === 'npc' ? h('button.small', { onclick: () => send({ type: 'entity.setHostile', entityId: id, hostile: !e.hostile }) }, e.hostile ? 'Mark friendly' : 'Mark hostile') : null) : null,
    e.attacks.length ? h('div.section-title', {}, c.active ? 'Attack (DM)' : 'Attacks (combat only)') : null,
    ...e.attacks.map((a) => h('div.inv-item', {},
      h('span', {}, a.name, ' ', h('span.muted', {}, `${a.attack} / ${a.damage} · r${a.range ?? 1}`)),
      e.kind !== 'pc' ? h('button.small', { disabled: !c.active || e.status !== 'active', onclick: () => setMode({ type: 'target', attacker: e, attack: a }) }, 'Use') : null)),
    h('div.section-title', {}, 'Inventory'),
    ...(e.inventory.length ? e.inventory.map((it) => h('div.inv-item', {}, it.name,
      h('button.small', { title: 'Remove', onclick: () => send({ type: 'item.remove', entityId: id, itemId: it.id }) }, '✕'))) : [h('p.muted', {}, 'Empty')]),
    h('form.row', {
      style: { marginTop: '6px' },
      onsubmit: (ev) => { ev.preventDefault(); if (itemInput.value.trim()) send({ type: 'item.add', entityId: id, name: itemInput.value }); },
    }, itemInput, h('button.small', { type: 'submit' }, 'Add')),
    h('div.row', { style: { marginTop: '12px' } },
      e.kind !== 'pc'
        ? h('button.small.danger', { onclick: () => confirm(`Remove ${e.name}?`) && send({ type: 'entity.remove', entityId: id }).then(() => select(null)) }, 'Remove from game')
        : h('button.small', { onclick: () => confirm(`Release ${e.name} from ${owner?.name}?`) && send({ type: 'dm.resetPlayer', playerId: e.ownerPlayerId }) }, 'Reset player / release character')),
  );
}

// Re-render a section only when its inputs change, so half-typed values survive unrelated updates.
const memoKeys = {};
function memo(name, key, fn) {
  const k = JSON.stringify(key);
  if (memoKeys[name] === k) return;
  memoKeys[name] = k;
  fn();
}

function render() {
  if (selectedId && !state.entities[selectedId]) selectedId = null;
  if (mode?.type === 'target' && (!state.combat.active || !state.entities[mode.attacker.id])) mode = null;
  const ents = Object.values(state.entities);
  renderTop();
  memo('scenes', [state.scenes, state.sceneOrder, state.activeSceneId, templates, ents.map((e) => [e.scope, e.sceneId])], renderScenes);
  memo('players', state.players, renderPlayers);
  memo('banks', [spawnScope, state.activeSceneId, ents.filter((e) => e.kind !== 'pc').map((e) => [e.id, e.name, e.hp, e.status, e.scope, e.sceneId])], renderBanks);
  renderBoard();
  const sel = selected();
  memo('inspector', [selectedId, sel, state.combat.active, state.turn[selectedId], sel && playerOf(sel), state.activeSceneId], renderInspector);
}

loadTemplates();
