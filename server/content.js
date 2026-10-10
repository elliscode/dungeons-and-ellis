import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, watch, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isValidDice } from './dice.js';
import { validateAbility } from './games/effects.js';
import { publicRoles } from './games/roles.js';

// Definition categories. characters/monsters/npcs are folders of *.json files (each an array or
// a single object); acts is the single file acts.json.
export const CATEGORIES = ['characters', 'monsters', 'npcs', 'acts'];
const FOLDER_CATEGORIES = ['characters', 'monsters', 'npcs'];
const FILE_RE = /^[a-z0-9][a-z0-9_-]*\.json$/;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ROLES = ['tank', 'dps', 'heal'];

export class ContentError extends Error {
  constructor(message, { errors = [], warnings = [], status = 400 } = {}) {
    super(message);
    this.errors = errors;
    this.warnings = warnings;
    this.status = status;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// files: [{ file, defs }] for one category. Returns { errors, warnings } with readable paths.
export function validateDefs(category, files, { imageExists } = {}) {
  const errors = [], warnings = [];
  const seen = new Map();
  for (const { file, defs } of files) {
    if (!Array.isArray(defs)) {
      errors.push(`${category}/${file}: must be a JSON array${category === 'acts' ? '' : ' or a single object'}`);
      continue;
    }
    defs.forEach((d, i) => {
      const at = `${category}/${file} › ${typeof d?.id === 'string' && d.id ? d.id : `#${i + 1}`}`;
      const err = (msg) => errors.push(`${at}: ${msg}`);
      if (!d || typeof d !== 'object' || Array.isArray(d)) return err('must be an object');
      if (typeof d.id !== 'string' || !ID_RE.test(d.id)) err('id must be lowercase letters, digits and dashes (e.g. "fire-mage")');
      else if (seen.has(d.id)) err(`duplicate id (also in ${seen.get(d.id)})`);
      else seen.set(d.id, file);
      if (typeof d.name !== 'string' || !d.name.trim()) err('name is required');
      if (category === 'acts') {
        if (d.roll != null && d.roll !== '' && !isValidDice(d.roll)) err(`roll "${d.roll}" is not valid dice`);
        return;
      }
      if (d.immortal !== undefined && typeof d.immortal !== 'boolean') err('immortal must be true or false');
      if (d.immortal === true) {
        if (category === 'characters') err('heroes cannot be immortal');
        if (d.maxHp !== undefined && d.maxHp !== null) err('immortal entities (training dummies) have no maxHp; remove it');
      } else if (!isNum(d.maxHp) || d.maxHp < 1) err('maxHp must be a number ≥ 1');
      for (const k of ['defense', 'movement']) if (d[k] !== undefined && !isNum(d[k])) err(`${k} must be a number`);
      if (d.actions !== undefined && !(Number.isInteger(d.actions) && d.actions >= 0 && d.actions <= 10)) err('actions must be a whole number from 0 to 10');
      if (category === 'characters' && !ROLES.includes(d.role)) err(`role must be one of ${ROLES.join(', ')}`);
      if (d.size !== undefined) {
        const ok = d.size && Number.isInteger(d.size.w) && Number.isInteger(d.size.h) && d.size.w >= 1 && d.size.h >= 1 && d.size.w <= 10 && d.size.h <= 10;
        if (!ok) err('size must be { "w": 1-10, "h": 1-10 }');
      }
      if (d.image !== undefined && d.image !== null) {
        if (typeof d.image !== 'string' || !d.image.startsWith('/static/')) err('image must be a path like /static/tokens/goblin.png');
        else if (imageExists && !imageExists(d.image)) warnings.push(`${at}: image ${d.image} does not exist (upload it on the Assets page)`);
      }
      if (d.attacks !== undefined && !Array.isArray(d.attacks)) err('attacks must be an array');
      (Array.isArray(d.attacks) ? d.attacks : []).forEach((a, j) => {
        const p = `attacks[${j}]`;
        if (!a || typeof a !== 'object') return err(`${p} must be an object`);
        if (typeof a.id !== 'string' || !a.id) err(`${p}.id is required`);
        if (typeof a.name !== 'string' || !a.name) err(`${p}.name is required`);
        for (const k of ['attack', 'damage']) if (!isValidDice(a[k])) err(`${p}.${k} "${a[k] ?? ''}" is not valid dice (e.g. 1d20+5)`);
        if (a.range !== undefined && !(Number.isInteger(a.range) && a.range >= 0)) err(`${p}.range must be a whole number of squares`);
      });
      if (d.abilities !== undefined && !Array.isArray(d.abilities)) err('abilities must be an array');
      (Array.isArray(d.abilities) ? d.abilities : []).forEach((a, j) => {
        const p = `abilities[${j}]`;
        if (!a || typeof a !== 'object') return err(`${p} must be an object`);
        if (typeof a.id !== 'string' || !a.id) err(`${p}.id is required`);
        if (typeof a.name !== 'string' || !a.name) err(`${p}.name is required`);
        for (const k of ['heal', 'roll']) if (a[k] != null && !isValidDice(a[k])) err(`${p}.${k} "${a[k]}" is not valid dice`);
        for (const m of validateAbility(a, `${p} (${a.id ?? '?'})`)) err(m);
      });
      if (d.inventory !== undefined && !(Array.isArray(d.inventory) && d.inventory.every((x) => typeof x === 'string' || typeof x?.name === 'string'))) {
        err('inventory must be an array of item names');
      }
    });
  }
  return { errors, warnings };
}

// Reloadable content store. The object identity never changes, so everything holding a reference
// (GameService, routes) sees new definitions after reload(). Emits 'change' when content changes.
export function loadContent(dir, { staticDir = null, watchFiles = false, pollMs = 2000 } = {}) {
  const store = new EventEmitter();
  let data = null;
  let snapshot = '';
  const watchers = [];
  let pollTimer = null;
  const imageExists = staticDir ? (p) => existsSync(join(staticDir, p.slice('/static/'.length))) : null;

  const folder = (category) => join(dir, category);
  const checkCategory = (category) => {
    if (!CATEGORIES.includes(category)) throw new ContentError(`Unknown category "${category}"`, { status: 404 });
  };
  const checkFile = (category, file) => {
    checkCategory(category);
    if (category === 'acts' ? file !== 'acts.json' : !FILE_RE.test(String(file))) {
      throw new ContentError('File names must look like "my-monsters.json" (lowercase letters, digits, - and _)');
    }
  };
  const pathOf = (category, file) => (category === 'acts' ? join(dir, 'acts.json') : join(folder(category), file));

  function fileNames(category) {
    if (category === 'acts') return existsSync(join(dir, 'acts.json')) ? ['acts.json'] : [];
    const d = folder(category);
    return existsSync(d) ? readdirSync(d).filter((f) => FILE_RE.test(f)).sort() : [];
  }

  // Reads one category from disk, with `override` = { file, text } substituted (or removed when text is null).
  function readCategory(category, override) {
    const errors = [];
    const files = [];
    const names = new Set(fileNames(category));
    if (override) names.add(override.file);
    for (const file of [...names].sort()) {
      let text;
      if (override?.file === file) {
        if (override.text === null) continue;
        text = override.text;
      } else {
        text = readFileSync(pathOf(category, file), 'utf8');
      }
      try {
        const parsed = JSON.parse(text);
        files.push({ file, defs: Array.isArray(parsed) || category === 'acts' ? parsed : [parsed] });
      } catch (e) {
        errors.push(`${category}/${file}: invalid JSON — ${e.message}`);
      }
    }
    const v = validateDefs(category, files, { imageExists });
    return { files, errors: [...errors, ...v.errors], warnings: v.warnings };
  }

  function build(override) {
    const result = { errors: [], warnings: [], lists: {}, perFile: {} };
    for (const category of CATEGORIES) {
      const r = readCategory(category, override?.category === category ? override : null);
      result.errors.push(...r.errors);
      result.warnings.push(...r.warnings);
      result.lists[category] = r.files.flatMap((f) => (Array.isArray(f.defs) ? f.defs : []));
      result.perFile[category] = r.files.map((f) => ({ name: f.file, count: Array.isArray(f.defs) ? f.defs.length : 0 }));
    }
    return result;
  }

  function apply(r) {
    const index = (list) => new Map(list.map((d) => [d.id, d]));
    data = {
      characters: r.lists.characters, monsters: r.lists.monsters, npcs: r.lists.npcs, acts: r.lists.acts,
      maps: { character: index(r.lists.characters), monster: index(r.lists.monsters), npc: index(r.lists.npcs) },
    };
    const snap = JSON.stringify(r.lists);
    const changed = snap !== snapshot;
    snapshot = snap;
    return changed;
  }

  Object.defineProperties(store, Object.getOwnPropertyDescriptors({
    get characters() { return data.characters; },
    get monsters() { return data.monsters; },
    get npcs() { return data.npcs; },
    get acts() { return data.acts; },
    def(kind, id) { return data.maps[kind]?.get(id) ?? null; },
    act(id) { return data.acts.find((a) => a.id === id) ?? null; },
    publicContent() { return { characters: data.characters, acts: data.acts, roles: publicRoles() }; },
    dmContent() { return { characters: data.characters, monsters: data.monsters, npcs: data.npcs, acts: data.acts }; },

    // Re-reads everything. Invalid content is rejected and the last good content stays loaded.
    reload() {
      const r = build();
      if (r.errors.length) return { ok: false, errors: r.errors, warnings: r.warnings };
      if (apply(r)) store.emit('change');
      return { ok: true, errors: [], warnings: r.warnings };
    },

    listFiles() {
      const r = build();
      return CATEGORIES.map((category) => ({ category, files: r.perFile[category] }));
    },

    readFile(category, file) {
      checkFile(category, file);
      const p = pathOf(category, file);
      if (!existsSync(p)) throw new ContentError('File not found', { status: 404 });
      return readFileSync(p, 'utf8');
    },

    // Validates the whole category with this file's new text before touching the disk.
    writeFile(category, file, text, { create = false } = {}) {
      checkFile(category, file);
      const p = pathOf(category, file);
      if (create && existsSync(p)) throw new ContentError(`${file} already exists`, { status: 409 });
      if (typeof text !== 'string' || text.length > 2_000_000) throw new ContentError('File content missing or too large');
      const r = build({ category, file, text });
      if (r.errors.length) throw new ContentError('Validation failed — nothing was saved', { errors: r.errors, warnings: r.warnings });
      mkdirSync(category === 'acts' ? dir : folder(category), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
      renameSync(tmp, p);
      if (apply(r)) store.emit('change');
      return { warnings: r.warnings };
    },

    deleteFile(category, file) {
      checkFile(category, file);
      if (category === 'acts') throw new ContentError('acts.json cannot be deleted (edit it instead)');
      const p = pathOf(category, file);
      if (!existsSync(p)) throw new ContentError('File not found', { status: 404 });
      const r = build({ category, file, text: null });
      if (r.errors.length) throw new ContentError('Deleting this file would leave invalid content', { errors: r.errors });
      unlinkSync(p);
      if (apply(r)) store.emit('change');
    },

    close() {
      for (const w of watchers) w.close();
      watchers.length = 0;
      clearInterval(pollTimer);
    },
  }));

  const initial = build();
  if (initial.errors.length) throw new Error(`Invalid content in ${dir}:\n  ${initial.errors.join('\n  ')}`);
  apply(initial);
  if (initial.warnings.length) console.warn(`${initial.warnings.length} content warning(s), e.g. ${initial.warnings[0]} — see the Data page`);

  // Pick up edits made directly on disk (debounced; editors often write several events).
  if (watchFiles) {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const r = store.reload();
        if (!r.ok) console.error(`content reload rejected (keeping previous content):\n  ${r.errors.join('\n  ')}`);
      }, 300);
      timer.unref?.();
    };
    const tryWatch = (path, filter) => {
      try {
        if (!existsSync(path)) return;
        watchers.push(watch(path, (ev, name) => { if (!filter || filter(String(name ?? ''))) schedule(); }));
      } catch (e) {
        console.warn(`cannot watch ${path}: ${e.message}`);
      }
    };
    for (const c of FOLDER_CATEGORIES) tryWatch(folder(c), (n) => n.endsWith('.json'));
    tryWatch(dir, (n) => n === 'acts.json');
    // fs.watch can miss events (notably on macOS right after a watch starts), so also compare a
    // cheap signature of the content files every few seconds.
    const signature = () => CATEGORIES.flatMap((c) => fileNames(c).map((f) => {
      try { const st = statSync(pathOf(c, f)); return `${c}/${f}:${st.mtimeMs}:${st.size}`; } catch { return `${c}/${f}`; }
    })).join('|');
    let last = signature();
    pollTimer = setInterval(() => {
      const now = signature();
      if (now !== last) { last = now; schedule(); }
    }, pollMs);
    pollTimer.unref?.();
  }
  return store;
}
