import { rollDice } from '../dice.js';
import { fail, isFriendly, footprintDistance, turnFor, actionAllowance } from './state.js';

// Validation and text helpers shared by commands.js and the ability engine (effects.js).

// Outcome words in feed text (HIT, MISS, SUCCESS…) are wrapped in private-use marker characters,
// and the client badges only marked words. Player-typed text has the markers stripped, so typing
// "HIT" in a name or custom action can't fake a badge.
export const outcome = (word) => `\uE000${word}\uE001`;
export const stripMarkers = (s) => s.replace(/[\uE000\uE001]/g, '');

export const str = (v, max, label) => {
  const s = typeof v === 'string' ? stripMarkers(v).trim() : '';
  if (!s) fail(`${label} is required`);
  return s.slice(0, max);
};
export const int = (v, label, min = -Infinity, max = Infinity) => {
  // A blank field must not silently become 0 (Number('') === 0).
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) fail(`${label} is required`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number${min > -Infinity ? ` from ${min} to ${max}` : ''}`);
  return n;
};

export function hpNote(e) {
  if (e.immortal) return `${e.name}: ${e.damageTaken} total damage`;
  return `${e.name} ${e.hp}/${e.maxHp}${e.status !== 'active' ? ` ${e.status.toUpperCase()}` : ''}`;
}
// Public text only reveals HP for PCs (never NPCs, which may turn hostile); the DM text always
// does. A training dummy's running damage total isn't secret, so everyone sees it.
export function hpTexts(e) {
  if (e.kind === 'object') return { pub: '', dm: '' };
  const dm = ` (${hpNote(e)})`;
  return { pub: e.kind === 'pc' || e.immortal ? dm : '', dm };
}

export function statusSuffix(e, change) {
  if (!change || change.before === change.after) return '';
  if (change.after === 'down') return ` ${e.name} is DOWN!`;
  if (change.after === 'dead') return e.kind === 'monster' ? ` ${e.name} is slain!` : ` ${e.name} has DIED!`;
  if (change.after === 'active' && change.before === 'down') return ` ${e.name} is back on their feet!`;
  if (change.after === 'active' && change.before === 'dead') return ` ${e.name} is revived!`;
  return '';
}

export function getEntity(ctx, id) {
  const e = ctx.state.entities[id];
  if (!e) fail('That token no longer exists');
  return e;
}

export function activeScene(ctx) {
  const id = ctx.state.activeSceneId;
  if (!id) fail('No active scene');
  return ctx.state.scenes[id];
}

export const inScene = (e, sceneId) => e.scope === 'game' || e.sceneId === sceneId;

export function onActiveScene(ctx, e) {
  const scene = activeScene(ctx);
  if (!inScene(e, scene.id)) fail(`${e.name} is not in this scene`);
  return scene;
}

// Grid distance between two entities on the active scene (footprint-aware).
export function distanceBetween(ctx, a, b) {
  const sid = ctx.state.activeSceneId;
  const pa = a.positions[sid], pb = b.positions[sid];
  if (!pa || !pb) return Infinity;
  return footprintDistance(pa, a.size, pb, b.size);
}

// The creature `e` is frightened of and would end up closer to by standing at (x, y), or null.
export function frightenedBy(ctx, e, sceneId, x, y) {
  for (const fx of e.effects ?? []) {
    if (fx.status !== 'frightened') continue;
    const src = ctx.state.entities[fx.params.sourceId];
    const sp = src?.positions[sceneId];
    if (!sp) continue;
    if (footprintDistance({ x, y }, e.size, sp, src.size) < distanceBetween(ctx, e, src)) return src;
  }
  return null;
}

// The entity the acting player controls (DM may act through any entity).
export function controlled(ctx, entityId) {
  const e = getEntity(ctx, entityId);
  if (ctx.actor.role === 'player' && e.ownerPlayerId !== ctx.actor.playerId) fail('That is not your character');
  return e;
}

export function requireStatus(e, verb) {
  if (e.status === 'dead') fail(`${e.name} is dead`);
  if (e.status === 'down') fail(`${e.name} is down and can only roll a d20`);
  if (verb && e.status !== 'active') fail(`${e.name} cannot ${verb}`);
}

// Players may act freely outside combat; in combat only during PLAYER PHASE.
export function requirePlayerWindow(ctx) {
  if (ctx.actor.role !== 'player') return;
  const c = ctx.state.combat;
  if (c.active && c.phase !== 'player') fail('Wait for the PLAYER PHASE');
}

// Enemies (monsters and hostile NPCs) act only during the DM PHASE; friendly NPCs, like the
// heroes they side with, only during the PLAYER PHASE.
export function requireActionWindow(ctx, e) {
  requirePlayerWindow(ctx);
  const c = ctx.state.combat;
  if (ctx.actor.role !== 'dm' || !c.active) return;
  if (!isFriendly(e) && c.phase !== 'dm') fail('Enemies act during the DM PHASE');
  if (isFriendly(e) && e.kind === 'npc' && c.phase !== 'player') fail('Friendly NPCs act during the PLAYER PHASE');
}

// Who pays from the per-phase action budget in combat: players always, and the DM when acting
// through an enemy or a friendly NPC. The DM acting through a hero, and the DM's own tools
// (damage, HP, kill...), are unlimited.
export function budgeted(ctx, e) {
  if (!ctx.state.combat.active) return false;
  if (ctx.actor.role === 'player') return true;
  return ctx.actor.role === 'dm' && (!isFriendly(e) || e.kind === 'npc');
}

export function checkAction(ctx, e, cost = 1) {
  if (!budgeted(ctx, e) || cost <= 0) return;
  const t = turnFor(ctx.state, e.id);
  if (t.actions + cost <= actionAllowance(e, t)) return;
  if (ctx.actor.role === 'player') fail('You have no actions left this phase');
  fail(`${e.name} has no actions left this phase (use +1 action to override)`);
}

// Consumes actions in combat when the actor pays (see budgeted()).
// Any action (even a free one) also locks in this phase's moves: they can no longer be undone.
export function spendAction(ctx, e, cost = 1) {
  if (budgeted(ctx, e)) turnFor(ctx.state, e.id).moves = [];
  if (!budgeted(ctx, e) || cost <= 0) return;
  checkAction(ctx, e, cost);
  turnFor(ctx.state, e.id).actions += cost;
}

export function rollOrFail(expr, ctx, opts) {
  try { return rollDice(expr, { rng: ctx.rng, ...opts }); } catch (err) { fail(err.message); }
}
