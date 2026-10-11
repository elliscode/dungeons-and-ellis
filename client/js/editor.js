import { $, fill, h, api, toast, popupMenu } from './common.js';
import { Board } from './board.js';

const id = location.pathname.split('/').pop();
let [tpl, assets, content] = await Promise.all([
  api('GET', `/api/scenes/${id}`), api('GET', '/api/assets'), api('GET', '/api/content'),
]);

const data = tpl.data;
data.entities ??= [];
let tool = { type: 'select' };
let dirty = false;
let defs = new Map([...content.monsters.map((d) => [`monster:${d.id}`, d]), ...content.npcs.map((d) => [`npc:${d.id}`, d])]);
const uid = (p) => `${p}_${Math.random().toString(16).slice(2, 10)}`;

$('#scene-name').value = tpl.name;
$('#scene-name').addEventListener('input', markDirty);

function markDirty() {
  dirty = true;
  $('#dirty').textContent = '• unsaved changes';
}
addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

const board = new Board($('#board'), {
  showSpawn: true,
  canDrag: () => tool.type === 'select',
  onCellClick: (cell) => place(cell),
  onTokenClick: (t, e, stack) => {
    if (tool.type === 'erase') return remove(t);
    if (tool.type !== 'select') return place(t.position);
    if (stack.length > 1) {
      return popupMenu(e.clientX, e.clientY, 'Stacked here', stack.map((s) => ({ label: s.name, onClick: () => editToken(s, e) })));
    }
    editToken(t, e);
  },
  onTokenDrop: (t, x, y) => {
    const item = findItem(t.id);
    if (!item) return;
    const g = data.grid;
    item.x = Math.max(0, Math.min(g.cols - (item.w ?? 1), x));
    item.y = Math.max(0, Math.min(g.rows - (item.h ?? 1), y));
    markDirty();
    render();
  },
});

function findItem(tid) {
  return data.entities.find((e) => e.id === tid);
}

function remove(t) {
  data.entities = data.entities.filter((e) => e.id !== t.id);
  markDirty();
  render();
}

function place(cell) {
  if (!cell) return;
  if (tool.type === 'spawn') {
    data.spawn = { x: cell.x, y: cell.y };
  } else if (tool.type === 'entity') {
    data.entities.push({ id: uid('t'), kind: tool.kind, defId: tool.defId, x: cell.x, y: cell.y });
  } else return;
  markDirty();
  render();
}

function editToken(t, e) {
  const item = findItem(t.id);
  if (!item) return;
  const form = h('form', {
    onsubmit: (ev) => {
      ev.preventDefault();
      const f = ev.target;
      if (f.label.value.trim()) item.name = f.label.value.trim();
      else delete item.name;
      markDirty();
      render();
      document.querySelector('.popup-menu')?.remove();
    },
  },
  h('input', { name: 'label', placeholder: 'Custom name (optional)', value: item.name ?? '' }),
  h('button.small.primary', { type: 'submit' }, 'Apply'));
  popupMenu(e.clientX, e.clientY, t.name, [
    { node: form },
    { label: '🗑 Remove', onClick: () => remove(t) },
  ]);
}

function tokens() {
  return data.entities.map((e, i) => {
    const d = defs.get(`${e.kind}:${e.defId}`);
    return {
      id: e.id, kind: e.kind, name: e.name ?? d?.name ?? e.defId, image: d?.image, size: d?.size ?? { w: 1, h: 1 },
      position: { x: e.x, y: e.y }, z: 100 + i, color: e.kind === 'monster' ? '#d63b3b' : '#d4af37',
    };
  });
}

function render() {
  board.setScene({ id: 'editor', background: data.background, bgScale: data.bgScale, grid: data.grid, spawn: data.spawn ?? null });
  board.sceneKey = null; // always redraw (spawn marker / grid edits)
  board.setTokens(tokens(), { showStacks: true });
  renderTools();
}

function setTool(t) {
  tool = t;
  renderTools();
}

function numberInput(label, key, min, max) {
  return h('label', {}, label, h('input', {
    type: 'number', min, max, value: data.grid[key],
    onchange: (e) => { data.grid[key] = Number(e.target.value); markDirty(); render(); },
  }));
}

let toolsBuilt = false;
function renderTools() {
  const root = $('#tools');
  if (!toolsBuilt) {
    toolsBuilt = true;
    const bgSelect = h('select', {
      onchange: (e) => { data.background = e.target.value || null; markDirty(); render(); },
    }, h('option', { value: '' }, '— none —'), ...assets.backgrounds.map((b) => h('option', { value: b, selected: b === data.background }, b.split('/').pop())));
    root.append(
      h('button.small', { onclick: refreshPalettes, title: 'Pick up newly uploaded art and edited definitions' }, '↻ Refresh assets & data'),
      h('div.section-title', {}, 'Background'),
      bgSelect,
      h('div.row', { style: { marginTop: '6px' } },
        h('label', {}, 'Scale', h('input', { type: 'number', step: 0.1, min: 0.1, max: 10, value: data.bgScale ?? 1, onchange: (e) => { data.bgScale = Number(e.target.value) || 1; markDirty(); render(); } })),
        h('button.small', { onclick: fitGrid, title: 'Size the grid to cover the background' }, 'Fit grid to image')),
      h('div.section-title', {}, 'Grid (independent of the image)'),
      h('div.row', {}, numberInput('Columns', 'cols', 1, 100), numberInput('Rows', 'rows', 1, 100), numberInput('Cell px', 'cellSize', 16, 256)),
      h('div.row', {}, numberInput('Offset X', 'offsetX', -2000, 2000), numberInput('Offset Y', 'offsetY', -2000, 2000)),
      h('div.row', {},
        h('label', {}, 'Line color', h('input', { type: 'color', value: data.grid.color ?? '#ffffff', onchange: (e) => { data.grid.color = e.target.value; markDirty(); render(); } })),
        h('label', {}, 'Opacity', h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: data.grid.opacity ?? 0.25, oninput: (e) => { data.grid.opacity = Number(e.target.value); markDirty(); render(); } }))),
      h('div.section-title', {}, 'Tools'),
      h('div.row', { id: 'tool-buttons' }),
      h('div.section-title', {}, 'Monsters'),
      h('div.tool-grid', { id: 'monster-palette' }),
      h('div.section-title', {}, 'NPCs'),
      h('div.tool-grid', { id: 'npc-palette' }),
      h('p.muted', { style: { fontSize: '12px' } }, 'Creatures placed here start as scene-scoped in each game that uses this template. Live games never change this template.'),
    );
  }
  const tb = $('#tool-buttons');
  fill(tb, 
    ...[['select', '✋ Select / move'], ['spawn', '⚑ Player spawn'], ['erase', '🗑 Erase']].map(([t, label]) =>
      h(`button.small${tool.type === t ? '.active' : ''}`, { onclick: () => setTool({ type: t }) }, label)),
    h('button.small', { onclick: () => { data.spawn = null; markDirty(); render(); }, title: 'Use the default bottom-left square' }, 'Reset spawn'));
  const pal = (rootId, items) => {
    fill($(rootId), ...items.map((it) => h(`button${it.active ? '.active' : ''}`, { onclick: it.onClick, title: it.name },
      it.image ? h('img', { src: it.image, alt: '' }) : null, it.name)));
  };
  for (const kind of ['monster', 'npc']) {
    pal(`#${kind}-palette`, content[`${kind === 'npc' ? 'npcs' : 'monsters'}`].map((d) => ({
      name: d.name, image: d.image,
      active: tool.type === 'entity' && tool.defId === d.id && tool.kind === kind,
      onClick: () => setTool({ type: 'entity', kind, defId: d.id }),
    })));
  }
}

async function refreshPalettes() {
  [assets, content] = await Promise.all([api('GET', '/api/assets'), api('GET', '/api/content')]);
  defs = new Map([...content.monsters.map((d) => [`monster:${d.id}`, d]), ...content.npcs.map((d) => [`npc:${d.id}`, d])]);
  fill($('#tools'));
  toolsBuilt = false;
  render();
  toast('Assets and data refreshed');
}

function fitGrid() {
  const img = new Image();
  img.onload = () => {
    const s = data.bgScale || 1;
    data.grid.cols = Math.max(1, Math.floor((img.naturalWidth * s - data.grid.offsetX) / data.grid.cellSize));
    data.grid.rows = Math.max(1, Math.floor((img.naturalHeight * s - data.grid.offsetY) / data.grid.cellSize));
    fill($('#tools'), );
    toolsBuilt = false;
    markDirty();
    render();
  };
  if (data.background) img.src = data.background;
}

$('#save').addEventListener('click', async () => {
  try {
    const saved = await api('PUT', `/api/scenes/${id}`, { ...data, name: $('#scene-name').value });
    Object.assign(data, saved.data);
    dirty = false;
    $('#dirty').textContent = '✓ saved';
    toast('Scene template saved');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setTool({ type: 'select' });
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); $('#save').click(); }
});

render();
