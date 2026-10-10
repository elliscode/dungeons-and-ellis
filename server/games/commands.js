import { isValidDice } from '../dice.js';
import { randomToken } from '../auth.js';
import {
  PLAYER_COLORS, fail, newId, entityFromDef, entitiesInScene, isFriendly, makeItem, turnFor, areEnemies,
} from './state.js';
import { inBounds, ensurePlaced } from './placement.js';
import { startCombat, advancePhase, endCombat, applyHeal, setHp, revive, kill, dealDamage } from './combat.js';
import { addEffect, removeEffect, effectsOf, movementAllowance } from './status.js';
import { activateAbility, strike, checkTaunt, resolveCheck, onPhaseTransition, STATUSES } from './effects.js';
import {
  str, int, hpTexts, statusSuffix, getEntity, onActiveScene, controlled, requireStatus, requirePlayerWindow,
  requireActionWindow, budgeted, checkAction, spendAction, rollOrFail, distanceBetween,
} from './helpers.js';

// Handler options:
//   who:        'dm' | 'player' | 'any' (dm or player) | 'join' | 'system'
//   undoable:   snapshot state before running so the DM can undo it
//   clearsUndo: structural change after which older snapshots no longer make sense
export const handlers = {};
const def = (type, opts, run) => { handlers[type] = { ...opts, run }; };

// Training dummies and objects have no HP to set, heal or kill.
function requireMortal(e) {
  if (e.immortal) fail(`${e.name} is a training dummy and can't die — use Remove`);
  if (e.kind === 'object') fail(`${e.name} is an object and has no HP`);
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

// "Goblin", "Goblin 2", ... so the DM can tell instances of the same definition apart.
function numberedName(ctx, def, kind) {
  const same = Object.values(ctx.state.entities).filter((o) => o.defId === def.id && o.kind === kind).length;
  return same ? `${def.name} ${same + 1}` : def.name;
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
      scope: 'scene', sceneId: id, z: ++ctx.state.zCounter, name: placement.name || numberedName(ctx, d, placement.kind),
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
  e.name = numberedName(ctx, d, kind);
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
  const amount = int(ctx.cmd.amount, 'Damage', 0, 1_000_000);
  if (e.kind === 'object') fail(`${e.name} is an object and can't take damage`);
  const d = dealDamage(ctx, { target: e, raw: amount, color: ctx.actorColor });
  const notes = d.notes.length ? ` (${d.raw}, ${d.notes.join(', ')})` : '';
  const v = d.victim;
  const text = `${v.name} takes ${d.dealt} damage${notes}.${statusSuffix(v, d.change)}`;
  const t = hpTexts(v);
  ctx.log('damage', text + t.pub, { dmText: text + t.dm, data: { targetId: v.id, dealt: d.dealt } });
});

def('entity.heal', { who: 'dm', undoable: 'heal' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const amount = int(ctx.cmd.amount, 'Healing', 0, 10000);
  requireMortal(e);
  if (e.status === 'dead') fail(`${e.name} is dead — revive them first`);
  const change = applyHeal(e, amount);
  ctx.fx({ kind: 'heal', entityId: e.id, text: `+${change.healed}`, color: ctx.actorColor });
  const t = hpTexts(e);
  const text = `${e.name} is healed for ${change.healed}.${statusSuffix(e, change)}`;
  ctx.log('heal', text + t.pub, { dmText: text + t.dm });
});

// DM HP tools. Max HP is applied before HP, so one command can raise both ("20 / 20").
// HP above max is refused rather than silently capped; blank fields are refused, never 0.
function applyHealth(ctx, e, { hp, maxHp }) {
  requireMortal(e);
  if (hp === undefined && maxHp === undefined) fail('Enter HP or max HP');
  const before = { hp: e.hp, maxHp: e.maxHp, status: e.status };
  if (maxHp !== undefined) {
    e.maxHp = int(maxHp, 'Max HP', 1, 100000);
    e.hp = Math.min(e.hp, e.maxHp);
  }
  if (hp !== undefined) {
    const value = int(hp, 'HP', 0, 100000);
    if (value > e.maxHp) fail(`HP can't be more than max HP (${e.maxHp}) — raise max HP too`);
    setHp(e, value);
  }
  const t = hpTexts(e);
  const suffix = statusSuffix(e, { before: before.status, after: e.status });
  const what = [maxHp !== undefined && e.maxHp !== before.maxHp ? 'max HP' : null, hp !== undefined ? 'HP' : null].filter(Boolean).join(' and ') || 'HP';
  ctx.log('hp', `DM adjusted ${e.name}.${suffix}${t.pub}`, { dmText: `DM set ${e.name} ${what}.${suffix}${t.dm}` });
}

def('entity.setHealth', { who: 'dm', undoable: 'set HP' }, (ctx) => {
  applyHealth(ctx, getEntity(ctx, ctx.cmd.entityId), { hp: ctx.cmd.hp, maxHp: ctx.cmd.maxHp });
});

def('entity.setHp', { who: 'dm', undoable: 'set HP' }, (ctx) => {
  applyHealth(ctx, getEntity(ctx, ctx.cmd.entityId), { hp: ctx.cmd.hp ?? null });
});

def('entity.setMaxHp', { who: 'dm', undoable: 'set max HP' }, (ctx) => {
  applyHealth(ctx, getEntity(ctx, ctx.cmd.entityId), { maxHp: ctx.cmd.maxHp ?? null });
});

def('entity.kill', { who: 'dm', undoable: 'kill' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  requireMortal(e);
  kill(e);
  ctx.log('death', e.kind === 'monster' ? `${e.name} is slain!` : `${e.name} has DIED!`);
});

def('entity.revive', { who: 'dm', undoable: 'revive' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  requireMortal(e);
  if (e.status === 'active') fail(`${e.name} is not down or dead`);
  revive(e);
  const t = hpTexts(e);
  ctx.log('revive', `${e.name} is revived!${t.pub}`, { dmText: `${e.name} is revived!${t.dm}` });
});

def('entity.setStatus', { who: 'dm', undoable: 'status override' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const status = ctx.cmd.status;
  if (!['active', 'down', 'dead'].includes(status)) fail('Unknown status');
  requireMortal(e);
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

// DM overrides for live effects and checks.
def('effect.remove', { who: 'dm', undoable: 'remove effect' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const fx = removeEffect(e, ctx.cmd.effectId);
  if (!fx) fail('That effect already ended');
  ctx.log('effect', `${fx.label} on ${e.name} ends`, { dmText: `DM removed ${fx.label} from ${e.name}` });
});

def('effect.addStatus', { who: 'dm', undoable: 'add status' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  const st = STATUSES[ctx.cmd.status];
  if (!st || ctx.cmd.status === 'frightened') fail('Pick poisoned, snared, shaken or slowed');
  if (e.kind === 'object') fail('Objects have no statuses');
  addEffect(ctx.state, e, {
    type: ctx.cmd.status === 'slowed' ? 'modify_movement' : 'apply_status', status: ctx.cmd.status, label: st.label, icon: st.icon,
    source: { entityId: null, name: 'DM' }, params: ctx.cmd.status === 'slowed' ? { amount: -2 } : {}, duration: 'next_dm_phase',
  });
  ctx.log('effect', `${e.name} is ${st.label.toLowerCase()}`);
});

def('check.resolve', { who: 'dm', undoable: 'check' }, (ctx) => resolveCheck(ctx, ctx.cmd.checkId, !!ctx.cmd.success));

def('entity.resetDummy', { who: 'dm' }, (ctx) => {
  const e = getEntity(ctx, ctx.cmd.entityId);
  if (!e.immortal) fail('Only training dummies keep a damage counter');
  e.damageTaken = 0;
  e.hits = 0;
  ctx.log('dummy', `${e.name}'s damage counter was reset`);
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
  const c = ctx.state.combat;
  // DM "force" moves skip every restriction (override). Otherwise players, and enemies moved by
  // the DM in combat, spend movement (after slows/snares) and respect frightened.
  const force = ctx.actor.role === 'dm' && ctx.cmd.force === true;
  if (ctx.actor.role === 'player') {
    requireStatus(e, 'move');
    requirePlayerWindow(ctx);
  }
  if (!force && from) {
    const paying = c.active && (ctx.actor.role === 'player' || !isFriendly(e));
    if (paying) {
      const dist = Math.max(Math.abs(x - from.x), Math.abs(y - from.y));
      const t = turnFor(ctx.state, e.id);
      const allowance = movementAllowance(e);
      if (t.moved + dist > allowance) {
        fail(`${ctx.actor.role === 'dm' ? `${e.name} has` : 'Not enough movement:'} ${Math.max(0, allowance - t.moved)} squares left${ctx.actor.role === 'dm' ? ' (Shift-drag to force)' : ''}`);
      }
      t.moved += dist;
    }
    for (const fx of e.effects ?? []) {
      if (fx.status !== 'frightened') continue;
      const src = ctx.state.entities[fx.params.sourceId];
      if (!src?.positions[scene.id]) continue;
      const before = distanceBetween(ctx, e, src);
      const sp = src.positions[scene.id];
      const dx = Math.max(0, sp.x - (x + e.size.w - 1), x - (sp.x + src.size.w - 1));
      const dy = Math.max(0, sp.y - (y + e.size.h - 1), y - (sp.y + src.size.h - 1));
      if (Math.max(dx, dy) < before) fail(`${e.name} is frightened of ${src.name} and can't move closer${ctx.actor.role === 'dm' ? ' (Shift-drag to force)' : ''}`);
    }
  }
  if (from && from.x === x && from.y === y) return;
  e.positions[scene.id] = { x, y };
  e.z = ++ctx.state.zCounter;
  ctx.log('move', `${e.name} ${force ? 'is moved' : 'moves'}`);
});

def('attack', { who: 'any', undoable: 'attack' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  const c = ctx.state.combat;
  if (!c.active) fail('Attacks are only available in combat');
  requireStatus(e, 'attack');
  requireActionWindow(ctx, e);
  checkAction(ctx, e);
  const attack = e.attacks.find((a) => a.id === ctx.cmd.attackId);
  if (!attack) fail('Unknown attack');
  const target = getEntity(ctx, ctx.cmd.targetId);
  if (target.id === e.id) fail('You cannot attack yourself');
  if (target.kind === 'object') fail(`${target.name} can't be attacked`);
  onActiveScene(ctx, target);
  if (target.status === 'dead') fail(`${target.name} is already dead`);
  const range = Number(attack.range) || 1;
  const dist = distanceBetween(ctx, e, target);
  if (dist > range) fail(`${target.name} is out of range (${dist} > ${range})`);
  checkTaunt(ctx, e, target);
  spendAction(ctx, e);

  const s = strike(ctx, { attacker: e, target, attack, color: ctx.actorColor });
  const head = `${e.name} uses ${attack.name} on ${target.name}: ${s.roll.text}`;
  const data = { strikes: [{ targetId: target.id, victimId: s.victim.id, hit: s.hit, crit: s.crit, dealt: s.dealt }] };
  if (!s.hit) {
    ctx.log('attack', `${head} — MISS`, { dmText: `${head} vs DEF ${s.roll.defense} — MISS`, data });
    return { hit: false };
  }
  const v = s.victim;
  const via = v !== target ? ` (${s.notes.find((n) => n.startsWith('intercepted')) ?? `hits ${v.name}`})` : '';
  const notes = s.notes.filter((n) => !n.startsWith('intercepted'));
  const tail = `${s.crit ? 'CRITICAL HIT' : 'HIT'} for ${s.dealt} (${s.dmg.text}${notes.length ? `, ${notes.join(', ')}` : ''})${via}.${s.suffix}`;
  const t = hpTexts(v);
  ctx.log('attack', `${head} — ${tail}${t.pub}`, { dmText: `${head} vs DEF ${s.roll.defense} — ${tail}${t.dm}`, data });
  return { hit: true, crit: s.crit, damage: s.dealt };
});

def('act', { who: 'any', undoable: 'act' }, (ctx) => {
  const e = controlled(ctx, ctx.cmd.entityId);
  onActiveScene(ctx, e);
  requireStatus(e, 'act');
  requireActionWindow(ctx, e);
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

// All abilities (heroes, NPCs, monsters) run through the shared effect engine.
def('ability', { who: 'any', undoable: 'ability' }, (ctx) => activateAbility(ctx));

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
  onPhaseTransition(ctx, 'start');
});

def('combat.end', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (!ctx.state.combat.active) fail('Combat is not running');
  endCombat(ctx.state);
  ctx.log('combat', 'Combat ends');
  onPhaseTransition(ctx, 'end');
});

function logPhase(ctx, prefix = '') {
  const c = ctx.state.combat;
  ctx.log('phase', `${prefix}${c.phase === 'player' ? 'PLAYER PHASE' : 'DM PHASE'} (round ${c.round})`);
}

def('combat.advance', { who: 'dm', clearsUndo: true }, (ctx) => {
  if (!ctx.state.combat.active) fail('Combat is not running');
  advancePhase(ctx.state, ctx.now);
  logPhase(ctx);
  onPhaseTransition(ctx, 'advance');
});

def('combat.timerExpired', { who: 'system', clearsUndo: true }, (ctx) => {
  const c = ctx.state.combat;
  if (!c.active || !c.phaseEndsAt || c.phaseEndsAt !== ctx.cmd.phaseEndsAt) fail('stale timer');
  advancePhase(ctx.state, ctx.now);
  logPhase(ctx, "⏰ Time's up! ");
  onPhaseTransition(ctx, 'advance');
});

def('combat.setTimer', { who: 'dm' }, (ctx) => {
  const seconds = int(ctx.cmd.seconds, 'Timer', 0, 3600);
  const c = ctx.state.combat;
  c.timerSeconds = seconds;
  if (c.active) c.phaseEndsAt = seconds > 0 ? ctx.now + seconds * 1000 : null;
  ctx.log('combat', seconds ? `Phase timer set to ${seconds}s` : 'Phase timer off', { dmOnly: !c.active });
});

export { entitiesInScene };
