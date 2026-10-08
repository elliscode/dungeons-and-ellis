import { rollDice, isValidDice } from '../dice.js';
import { randomToken } from '../auth.js';
import {
  PLAYER_COLORS, fail, newId, entityFromDef, entitiesInScene, isFriendly, footprintDistance,
  makeItem, turnFor,
} from './state.js';
import { inBounds, ensurePlaced } from './placement.js';
import {
  startCombat, advancePhase, endCombat, applyDamage, applyHeal, setHp, revive, kill, resolveAttack,
} from './combat.js';

// Handler options:
//   who:        'dm' | 'player' | 'any' (dm or player) | 'join' | 'system'
//   undoable:   snapshot state before running so the DM can undo it
//   clearsUndo: structural change after which older snapshots no longer make sense
export const handlers = {};
const def = (type, opts, run) => { handlers[type] = { ...opts, run }; };

// ---------- helpers ----------

const str = (v, max, label) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) fail(`${label} is required`);
  return s.slice(0, max);
};
const int = (v, label, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number${min > -Infinity ? ` from ${min} to ${max}` : ''}`);
  return n;
};

function hpNote(e) {
  return `${e.name} ${e.hp}/${e.maxHp}${e.status !== 'active' ? ` ${e.status.toUpperCase()}` : ''}`;
}
// Public log text only reveals HP for friendly entities; the DM text always does.
function hpTexts(e) {
  const dm = ` (${hpNote(e)})`;
  return { pub: isFriendly(e) ? dm : '', dm };
}

function statusSuffix(e, change) {
  if (!change || change.before === change.after) return '';
  if (change.after === 'down') return ` ${e.name} is DOWN!`;
  if (change.after === 'dead') return e.kind === 'monster' ? ` ${e.name} is slain!` : ` ${e.name} has DIED!`;
  if (change.after === 'active' && change.before === 'down') return ` ${e.name} is back on their feet!`;
  return '';
}

function getEntity(ctx, id) {
  const e = ctx.state.entities[id];
  if (!e) fail('That token no longer exists');
  return e;
}

function activeScene(ctx) {
  const id = ctx.state.activeSceneId;
  if (!id) fail('No active scene');
  return ctx.state.scenes[id];
}

function onActiveScene(ctx, e) {
  const scene = activeScene(ctx);
  if (e.scope !== 'game' && e.sceneId !== scene.id) fail(`${e.name} is not in this scene`);
  return scene;
}

// The entity the acting player controls (DM may act through any entity).
function controlled(ctx, entityId) {
  const e = getEntity(ctx, entityId);
  if (ctx.actor.role === 'player' && e.ownerPlayerId !== ctx.actor.playerId) fail('That is not your character');
  return e;
}

function requireStatus(e, verb) {
  if (e.status === 'dead') fail(`${e.name} is dead`);
  if (e.status === 'down') fail(`${e.name} is down and can only roll a d20`);
  if (verb && e.status !== 'active') fail(`${e.name} cannot ${verb}`);
}

// Players may act freely outside combat; in combat only during PLAYER PHASE.
function requirePlayerWindow(ctx) {
  if (ctx.actor.role !== 'player') return;
  const c = ctx.state.combat;
  if (c.active && c.phase !== 'player') fail('Wait for the PLAYER PHASE');
}

// Consumes one action in combat (players only). Returns nothing outside combat.
function spendAction(ctx, e) {
  if (ctx.actor.role !== 'player' || !ctx.state.combat.active) return;
  const t = turnFor(ctx.state, e.id);
  if (t.actions >= 1 + t.bonus) fail('You have already used your action this phase');
  t.actions += 1;
}

function checkAction(ctx, e) {
  if (ctx.actor.role !== 'player' || !ctx.state.combat.active) return;
  const t = turnFor(ctx.state, e.id);
  if (t.actions >= 1 + t.bonus) fail('You have already used your action this phase');
}

function rollOrFail(expr, ctx, opts) {
  try { return rollDice(expr, { rng: ctx.rng, ...opts }); } catch (err) { fail(err.message); }
}

function damageEntity(ctx, target, amount, color, sourceText) {
  const change = applyDamage(target, amount);
  const t = hpTexts(target);
  ctx.fx({ kind: 'damage', entityId: target.id, text: `-${amount}`, color });
  return { change, text: `${sourceText}${statusSuffix(target, change)}`, t };
}

// ---------- players & identity ----------

def('player.create', { who: 'join' }, (ctx) => {
  const name = str(ctx.cmd.name, 24, 'Name');
  const used = new Set(Object.values(ctx.state.players).map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c));
  if (!color) fail('This game is full (10 players)');
  let id;
  do id = newId('p'); while (ctx.state.players[id]);
  const seatSecret = randomToken(16);
  ctx.state.players[id] = { id, name, color, seatSecret, characterId: null, entityId: null, joinedAt: ctx.now };
  ctx.log('join', `${name} joined the game`, { color });
  return { playerId: id, seatSecret };
});

def('player.setName', { who: 'player' }, (ctx) => {
  const name = str(ctx.cmd.name, 24, 'Name');
  const old = ctx.player.name;
  if (old === name) return;
  ctx.player.name = name;
  ctx.log('player', `${old} is now known as ${name}`);
});

function setColor(ctx, player, color) {
  if (!PLAYER_COLORS.includes(color)) fail('Pick a color from the bank');
  const other = Object.values(ctx.state.players).find((p) => p.color === color && p.id !== player.id);
  if (other) fail(`${other.name} already has that color`);
  player.color = color;
}

def('player.setColor', { who: 'player' }, (ctx) => setColor(ctx, ctx.player, ctx.cmd.color));

def('player.selectCharacter', { who: 'player', clearsUndo: true }, (ctx) => {
  const p = ctx.player;
  if (p.characterId) fail('You already have a character');
  const chr = ctx.content.def('character', ctx.cmd.characterId);
  if (!chr) fail('Unknown character');
  const owner = Object.values(ctx.state.players).find((o) => o.characterId === chr.id);
  if (owner) fail(`${chr.name} has already been chosen by ${owner.name}`);
  const e = entityFromDef(chr, 'pc', { scope: 'game', ownerPlayerId: p.id, z: ++ctx.state.zCounter });
  ctx.state.entities[e.id] = e;
  p.characterId = chr.id;
  p.entityId = e.id;
  ctx.log('character', `${p.name} plays ${chr.name} (${String(chr.role).toUpperCase()})`);
});

function releaseCharacter(ctx, p) {
  if (p.entityId) {
    delete ctx.state.entities[p.entityId];
    delete ctx.state.turn[p.entityId];
  }
  p.characterId = null;
  p.entityId = null;
}

function getPlayer(ctx, id) {
  const p = ctx.state.players[id];
  if (!p) fail('Unknown player');
  return p;
}

def('dm.resetPlayer', { who: 'dm', clearsUndo: true }, (ctx) => {
  const p = getPlayer(ctx, ctx.cmd.playerId);
  const had = p.characterId ? ctx.content.def('character', p.characterId)?.name ?? p.characterId : null;
  releaseCharacter(ctx, p);
  ctx.log('character', had ? `DM released ${had} from ${p.name}` : `DM reset ${p.name}`);
});

// Removes the seat entirely. The old browser's credentials stop working.
def('dm.removePlayer', { who: 'dm', clearsUndo: true }, (ctx) => {
  const p = getPlayer(ctx, ctx.cmd.playerId);
  releaseCharacter(ctx, p);
  delete ctx.state.players[p.id];
  ctx.log('player', `DM removed ${p.name} from the game`);
});

def('dm.setPlayerColor', { who: 'dm' }, (ctx) => setColor(ctx, getPlayer(ctx, ctx.cmd.playerId), ctx.cmd.color));

def('dm.renameGame', { who: 'dm' }, (ctx) => {
  ctx.state.name = str(ctx.cmd.name, 60, 'Name');
});

// ---------- scenes ----------

def('scene.add', { who: 'dm', clearsUndo: true }, (ctx) => {
  const tpl = ctx.templates.get(ctx.cmd.templateId);
  if (!tpl) fail('Unknown scene template');
  const data = structuredClone(tpl.data);
  const sameName = Object.values(ctx.state.scenes).filter((s) => s.templateId === tpl.id).length;
  const id = newId('s');
  const scene = {
    id,
    templateId: tpl.id,
    name: sameName ? `${tpl.name} (${sameName + 1})` : tpl.name,
    background: data.background ?? null,
    grid: data.grid,
    objects: data.objects ?? [],
    spawn: data.spawn ?? null,
  };
  ctx.state.scenes[id] = scene;
  ctx.state.sceneOrder.push(id);
  for (const placement of data.entities ?? []) {
    const d = ctx.content.def(placement.kind, placement.defId);
    if (!d) continue;
    const e = entityFromDef(d, placement.kind, {
      scope: 'scene', sceneId: id, z: ++ctx.state.zCounter,
      ...(placement.name ? { name: placement.name } : {}),
    });
    if (inBounds(scene, placement.x, placement.y, e.size)) e.positions[id] = { x: placement.x, y: placement.y };
    ctx.state.entities[e.id] = e;
  }
  ensurePlaced(ctx.state, id);
  ctx.log('scene', `DM added scene "${scene.name}"`, { dmOnly: true });
  return { sceneId: id };
});

def('scene.remove', { who: 'dm', clearsUndo: true }, (ctx) => {
  const scene = ctx.state.scenes[ctx.cmd.sceneId];
  if (!scene) fail('Unknown scene');
  for (const e of Object.values(ctx.state.entities)) {
    if (e.scope === 'scene' && e.sceneId === scene.id) {
      delete ctx.state.entities[e.id];
      delete ctx.state.turn[e.id];
    } else {
      delete e.positions[scene.id];
    }
  }
  delete ctx.state.scenes[scene.id];
  ctx.state.sceneOrder = ctx.state.sceneOrder.filter((s) => s !== scene.id);
  if (ctx.state.activeSceneId === scene.id) ctx.state.activeSceneId = null;
  ctx.log('scene', `DM removed scene "${scene.name}"`, { dmOnly: true });
});

def('scene.rename', { who: 'dm' }, (ctx) => {
  const scene = ctx.state.scenes[ctx.cmd.sceneId];
  if (!scene) fail('Unknown scene');
  scene.name = str(ctx.cmd.name, 60, 'Name');
});

def('scene.activate', { who: 'dm', clearsUndo: true }, (ctx) => {
  const id = ctx.cmd.sceneId ?? null;
  if (id !== null && !ctx.state.scenes[id]) fail('Unknown scene');
  if (ctx.state.activeSceneId === id) return;
  ctx.state.activeSceneId = id;
  if (id) {
    ensurePlaced(ctx.state, id);
    ctx.log('scene', `The party enters ${ctx.state.scenes[id].name}`);
  } else {
    ctx.log('scene', 'The DM cleared the active scene');
  }
});

// ---------- entities (DM) ----------

def('entity.spawn', { who: 'dm', undoable: 'spawn' }, (ctx) => {
  const { kind, defId } = ctx.cmd;
  if (kind !== 'npc' && kind !== 'monster') fail('Can only spawn NPCs or monsters');
  const d = ctx.content.def(kind, defId);
  if (!d) fail('Unknown definition');
  const scope = ctx.cmd.scope === 'game' ? 'game' : 'scene';
  const sceneId = ctx.cmd.sceneId ?? ctx.state.activeSceneId;
  if (scope === 'scene' && !ctx.state.scenes[sceneId]) fail('Pick a scene first');
  const e = entityFromDef(d, kind, { scope, sceneId: scope === 'scene' ? sceneId : null, z: ++ctx.state.zCounter });
  const scene = ctx.state.scenes[sceneId];
  if (scene && ctx.cmd.x !== undefined && inBounds(scene, ctx.cmd.x, ctx.cmd.y, e.size)) {
    e.positions[sceneId] = { x: ctx.cmd.x, y: ctx.cmd.y };
  }
  // Number duplicates so the DM can tell "Goblin 2" from "Goblin".
  const same = Object.values(ctx.state.entities).filter((o) => o.defId === d.id && o.kind === kind).length;
  if (same) e.name = `${d.name} ${same + 1}`;
  ctx.state.entities[e.id] = e;
  if (scene) ensurePlaced(ctx.state, sceneId);
  ctx.log('spawn', `${e.name} appears`, { dmText: `DM spawned ${e.name} (${scope} scope)` });
  return { entityId: e.id };
});

def('entity.remove', { who: 'dm', undoable: 'remove' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.kind === 'pc') fail('Use Reset Player to release a player character');
  delete ctx.state.entities[e.id];
  delete ctx.state.turn[e.id];
  ctx.log('spawn', `${e.name} is gone`, { dmText: `DM removed ${e.name}` });
});

def('entity.setScope', { who: 'dm', undoable: 'scope change' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.kind === 'pc') fail('Player characters always follow the party');
  const scope = ctx.cmd.scope;
  if (scope === e.scope) return;
  if (scope === 'game') {
    e.scope = 'game';
    e.sceneId = null;
  } else if (scope === 'scene') {
    const sceneId = ctx.cmd.sceneId ?? ctx.state.activeSceneId;
    if (!ctx.state.scenes[sceneId]) fail('Pick a scene to leave them in');
    e.scope = 'scene';
    e.sceneId = sceneId;
    ensurePlaced(ctx.state, sceneId);
  } else fail('Scope must be "scene" or "game"');
  ctx.log('scope', `DM made ${e.name} ${scope === 'game' ? 'follow the party (game scope)' : `stay in ${ctx.state.scenes[e.sceneId].name} (scene scope)`}`, { dmOnly: true });
});

def('entity.setHostile', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.kind === 'pc') fail('Player characters are always friendly');
  e.hostile = !!ctx.cmd.hostile;
  ctx.log('entity', `DM marked ${e.name} as ${e.hostile ? 'hostile' : 'friendly'}`, { dmOnly: true });
});

def('entity.rename', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  e.name = str(ctx.cmd.name, 40, 'Name');
});

def('entity.damage', { who: 'dm', undoable: 'damage' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const amount = int(ctx.cmd.amount, 'Damage', 0, 10000);
  const r = damageEntity(ctx, e, amount, ctx.actorColor, `${e.name} takes ${amount} damage.`);
  ctx.log('damage', r.text + r.t.pub, { dmText: r.text + r.t.dm });
});

def('entity.heal', { who: 'dm', undoable: 'heal' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const amount = int(ctx.cmd.amount, 'Healing', 0, 10000);
  if (e.status === 'dead') fail(`${e.name} is dead — revive them first`);
  const change = applyHeal(e, amount);
  ctx.fx({ kind: 'heal', entityId: e.id, text: `+${change.healed}`, color: ctx.actorColor });
  const t = hpTexts(e);
  const text = `${e.name} is healed for ${change.healed}.${statusSuffix(e, change)}`;
  ctx.log('heal', text + t.pub, { dmText: text + t.dm });
});

def('entity.setHp', { who: 'dm', undoable: 'set HP' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const before = e.status;
  setHp(e, int(ctx.cmd.hp, 'HP', 0, 100000));
  const t = hpTexts(e);
  const suffix = statusSuffix(e, { before, after: e.status });
  ctx.log('hp', `DM adjusted ${e.name}.${suffix}${t.pub}`, { dmText: `DM set ${e.name} HP.${suffix}${t.dm}` });
});

def('entity.setMaxHp', { who: 'dm', undoable: 'set max HP' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  e.maxHp = int(ctx.cmd.maxHp, 'Max HP', 1, 100000);
  e.hp = Math.min(e.hp, e.maxHp);
});

def('entity.kill', { who: 'dm', undoable: 'kill' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  kill(e);
  ctx.log('death', e.kind === 'monster' ? `${e.name} is slain!` : `${e.name} has DIED!`);
});

def('entity.revive', { who: 'dm', undoable: 'revive' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (e.status === 'active') fail(`${e.name} is not down or dead`);
  revive(e);
  const t = hpTexts(e);
  ctx.log('revive', `${e.name} is revived!${t.pub}`, { dmText: `${e.name} is revived!${t.dm}` });
});

def('entity.setStatus', { who: 'dm', undoable: 'status override' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const status = ctx.cmd.status;
  if (!['active', 'down', 'dead'].includes(status)) fail('Unknown status');
  e.status = status;
  if (status === 'active') e.hp = Math.max(1, e.hp);
  else e.hp = 0;
  ctx.log('hp', `DM set ${e.name} to ${status.toUpperCase()}`);
});

def('entity.grantAction', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  turnFor(ctx.state, e.id).bonus += 1;
  ctx.log('action', `DM grants ${e.name} an extra action`);
});

def('item.add', { who: 'dm', undoable: 'add item' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const item = makeItem(str(ctx.cmd.name, 60, 'Item name'));
  e.inventory.push(item);
  ctx.log('item', `${e.name} received ${item.name}`, { dmOnly: !isFriendly(e) });
});

def('item.remove', { who: 'dm', undoable: 'remove item' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const idx = e.inventory.findIndex((i) => i.id === ctx.cmd.itemId);
  if (idx < 0) fail('Item not found');
  const [item] = e.inventory.splice(idx, 1);
  ctx.log('item', `DM removed ${item.name} from ${e.name}`, { dmOnly: true });
});

// ---------- gameplay (players and DM) ----------

def('move', { who: 'any', undoable: 'move' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  const scene = onActiveScene(ctx, e);
  const x = Number(ctx.cmd.x), y = Number(ctx.cmd.y);
  if (!inBounds(scene, x, y, e.size)) fail('You cannot move there');
  const from = e.positions[scene.id];
  if (ctx.actor.role === 'player') {
    requireStatus(e, 'move');
    requirePlayerWindow(ctx);
    if (ctx.state.combat.active && from) {
      const dist = Math.max(Math.abs(x - from.x), Math.abs(y - from.y));
      const t = turnFor(ctx.state, e.id);
      if (t.moved + dist > e.movement) fail(`Not enough movement (${e.movement - t.moved} squares left)`);
      t.moved += dist;
    }
  }
  if (from && from.x === x && from.y === y) return;
  e.positions[scene.id] = { x, y };
  e.z = ++ctx.state.zCounter;
  ctx.log('move', `${e.name} moves`, { quiet: true });
});

def('attack', { who: 'any', undoable: 'attack' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  const scene = onActiveScene(ctx, e);
  const c = ctx.state.combat;
  if (!c.active) fail('Attacks are only available in combat');
  requireStatus(e, 'attack');
  requirePlayerWindow(ctx);
  if (ctx.actor.role === 'player') checkAction(ctx, e);
  const attack = e.attacks.find((a) => a.id === ctx.cmd.attackId);
  if (!attack) fail('Unknown attack');
  const target = getEntity(ctx, ctx.cmd.targetId);
  if (target.id === e.id) fail('You cannot attack yourself');
  onActiveScene(ctx, target);
  if (target.status === 'dead') fail(`${target.name} is already dead`);
  const pa = e.positions[scene.id], pb = target.positions[scene.id];
  const range = Number(attack.range) || 1;
  const dist = footprintDistance(pa, e.size, pb, target.size);
  if (dist > range) fail(`${target.name} is out of range (${dist} > ${range})`);
  spendAction(ctx, e);

  const r = resolveAttack(attack, target, ctx.rng);
  const head = `${e.name} uses ${attack.name} on ${target.name}: ${r.attackRoll.text}`;
  if (!r.hit) {
    ctx.fx({ kind: 'miss', entityId: target.id, text: 'MISS', color: ctx.actorColor });
    ctx.log('attack', `${head} — MISS`, { dmText: `${head} vs DEF ${target.defense} — MISS` });
    return { hit: false };
  }
  if (r.crit) ctx.fx({ kind: 'crit', entityId: target.id, text: 'CRIT', color: ctx.actorColor });
  const d = damageEntity(ctx, target, r.damage, ctx.actorColor,
    `${head} — ${r.crit ? 'CRITICAL HIT' : 'HIT'} for ${r.damage} (${r.damageRoll.text}).`);
  ctx.log('attack', d.text + d.t.pub, { dmText: d.text.replace(' — ', ` vs DEF ${target.defense} — `) + d.t.dm });
  return { hit: true, crit: r.crit, damage: r.damage };
});

def('act', { who: 'any', undoable: 'act' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  requireStatus(e, 'act');
  requirePlayerWindow(ctx);
  let name, roll;
  if (ctx.cmd.actId) {
    const a = ctx.content.act(ctx.cmd.actId);
    if (!a) fail('Unknown act');
    name = a.name;
    roll = a.roll;
  } else {
    name = str(ctx.cmd.text, 80, 'Action');
    roll = ctx.cmd.roll || null;
  }
  if (roll && !isValidDice(roll)) fail(`Invalid roll "${roll}"`);
  const target = ctx.cmd.targetId ? ctx.state.entities[ctx.cmd.targetId] : null;
  spendAction(ctx, e);
  const r = roll ? rollOrFail(roll, ctx) : null;
  const on = target ? ` on ${target.name}` : '';
  ctx.log('act', `${e.name}: ${name}${on}${r ? ` — rolls ${roll}: ${r.text}` : ''}`);
});

def('ability', { who: 'any', undoable: 'ability' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  const scene = onActiveScene(ctx, e);
  requireStatus(e, 'use abilities');
  requirePlayerWindow(ctx);
  const ab = e.abilities.find((a) => a.id === ctx.cmd.abilityId);
  if (!ab) fail('Unknown ability');
  const inCombat = ctx.state.combat.active && ctx.actor.role === 'player';
  const t = inCombat ? turnFor(ctx.state, e.id) : null;
  if (t && ab.grantsActions) {
    if (t.abilitiesUsed.includes(ab.id)) fail(`${ab.name} can only be used once per phase`);
  } else if (!ab.free) {
    checkAction(ctx, e);
  }

  let target = null;
  if (ab.heal) {
    target = getEntity(ctx, ctx.cmd.targetId ?? e.id);
    onActiveScene(ctx, target);
    if (target.status === 'dead') fail(`${target.name} is dead`);
    const dist = footprintDistance(e.positions[scene.id], e.size, target.positions[scene.id], target.size);
    if (dist > (Number(ab.range) || 1)) fail(`${target.name} is out of range`);
  }

  if (t && ab.grantsActions) {
    t.abilitiesUsed.push(ab.id);
    t.bonus += Number(ab.grantsActions);
  } else if (!ab.free) {
    spendAction(ctx, e);
  }

  if (ab.heal) {
    const r = rollOrFail(ab.heal, ctx);
    const change = applyHeal(target, r.total);
    ctx.fx({ kind: 'heal', entityId: target.id, text: `+${change.healed}`, color: ctx.actorColor });
    const ht = hpTexts(target);
    const text = `${e.name} uses ${ab.name} on ${target.name}: ${r.text} healed.${statusSuffix(target, change)}`;
    ctx.log('heal', text + ht.pub, { dmText: text + ht.dm });
    return;
  }
  const r = ab.roll ? rollOrFail(ab.roll, ctx) : null;
  const extra = ab.grantsActions && t ? ` (+${ab.grantsActions} action)` : '';
  ctx.log('ability', `${e.name} uses ${ab.name}${extra}${r ? ` — rolls ${ab.roll}: ${r.text}` : ''}`);
});

def('item.use', { who: 'player', undoable: 'use item' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  requireStatus(e, 'use items');
  requirePlayerWindow(ctx);
  const idx = e.inventory.findIndex((i) => i.id === ctx.cmd.itemId);
  if (idx < 0) fail('Item not found');
  spendAction(ctx, e);
  const [item] = e.inventory.splice(idx, 1);
  const target = ctx.cmd.targetId ? ctx.state.entities[ctx.cmd.targetId] : null;
  ctx.log('item', `${e.name} uses ${item.name}${target && target.id !== e.id ? ` on ${target.name}` : ''}`);
});

// A downed character's only option: roll a d20 (the DM decides what it means).
def('downRoll', { who: 'player' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  if (e.status !== 'down') fail('Only downed characters make this roll');
  requirePlayerWindow(ctx);
  spendAction(ctx, e);
  const r = rollOrFail('1d20', ctx);
  ctx.log('roll', `${e.name} (DOWN) rolls a d20: ${r.total}${r.total === 20 ? ' — NATURAL 20!' : r.total === 1 ? ' — natural 1…' : ''}`);
});

def('roll', { who: 'any' }, (ctx) => {
  const expr = str(ctx.cmd.expr, 40, 'Dice');
  const r = rollOrFail(expr, ctx);
  const secret = ctx.actor.role === 'dm' && ctx.cmd.secret;
  ctx.log('roll', `${ctx.actorName} rolls ${r.expr}: ${r.text}`, secret ? { dmOnly: true } : {});
});

// ---------- combat ----------

def('combat.start', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (ctx.state.combat.active) fail('Combat is already running');
  startCombat(ctx.state, ctx.now);
  ctx.log('combat', '⚔️ COMBAT BEGINS — PLAYER PHASE (round 1)');
});

def('combat.end', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (!ctx.state.combat.active) fail('Combat is not running');
  endCombat(ctx.state);
  ctx.log('combat', 'Combat ends');
});

function logPhase(ctx, prefix = '') {
  const c = ctx.state.combat;
  ctx.log('phase', `${prefix}${c.phase === 'player' ? 'PLAYER PHASE' : 'DM PHASE'} (round ${c.round})`);
}

def('combat.advance', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (!ctx.state.combat.active) fail('Combat is not running');
  advancePhase(ctx.state, ctx.now);
  logPhase(ctx);
});

def('combat.timerExpired', { who: 'system', clearsUndo: true }, (ctx) => {
  const c = ctx.state.combat;
  if (!c.active || !c.phaseEndsAt || c.phaseEndsAt !== ctx.cmd.phaseEndsAt) fail('stale timer');
  advancePhase(ctx.state, ctx.now);
  logPhase(ctx, "⏰ Time's up! ");
});

def('combat.setTimer', { who: 'dm' }, (ctx) => {
  const seconds = int(ctx.cmd.seconds, 'Timer', 0, 3600);
  const c = ctx.state.combat;
  c.timerSeconds = seconds;
  if (c.active) c.phaseEndsAt = seconds > 0 ? ctx.now + seconds * 1000 : null;
  ctx.log('combat', seconds ? `Phase timer set to ${seconds}s` : 'Phase timer off', { dmOnly: !c.active });
});

export { entitiesInScene };
