import { rollDice } from '../dice.js';

export function phaseDurationEnd(state, now) {
  const s = state.combat.timerSeconds;
  return s > 0 ? now + s * 1000 : null;
}

export function startCombat(state, now) {
  state.combat.active = true;
  state.combat.phase = 'player';
  state.combat.round = 1;
  state.combat.phaseEndsAt = phaseDurationEnd(state, now);
  state.turn = {};
}

export function advancePhase(state, now) {
  const c = state.combat;
  if (c.phase === 'player') {
    c.phase = 'dm';
  } else {
    c.phase = 'player';
    c.round += 1;
  }
  c.phaseEndsAt = phaseDurationEnd(state, now);
  state.turn = {};
}

export function endCombat(state) {
  Object.assign(state.combat, { active: false, phase: null, round: 0, phaseEndsAt: null });
  state.turn = {};
}

// Returns the resulting status transition, if any. PCs and NPCs go DOWN at 0 HP and die when a
// downed creature takes damage >= max HP. Monsters die at 0 HP.
export function applyDamage(e, amount) {
  amount = Math.max(0, Math.floor(amount));
  const before = e.status;
  if (e.status === 'dead') return { before, after: before };
  if (e.status === 'down') {
    if (amount >= e.maxHp) e.status = 'dead';
  } else {
    e.hp = Math.max(0, e.hp - amount);
    if (e.hp === 0) e.status = e.kind === 'monster' ? 'dead' : 'down';
  }
  return { before, after: e.status };
}

export function applyHeal(e, amount) {
  amount = Math.max(0, Math.floor(amount));
  const before = e.status;
  if (e.status === 'dead') return { before, after: before, healed: 0 };
  const old = e.hp;
  e.hp = Math.min(e.maxHp, e.hp + amount);
  if (e.status === 'down' && e.hp > 0) e.status = 'active';
  return { before, after: e.status, healed: e.hp - old };
}

export function setHp(e, value) {
  e.hp = Math.max(0, Math.min(e.maxHp, Math.floor(value)));
  if (e.hp > 0 && e.status === 'down') e.status = 'active';
  if (e.hp === 0 && e.status === 'active') e.status = e.kind === 'monster' ? 'dead' : 'down';
}

export function revive(e) {
  e.status = 'active';
  e.hp = Math.max(1, e.hp);
}

export function kill(e) {
  e.status = 'dead';
  e.hp = 0;
}

// Natural 20 = critical hit (damage dice doubled); natural 1 = automatic miss.
export function resolveAttack(attack, target, rng) {
  const attackRoll = rollDice(attack.attack || '1d20', { rng });
  const nat = attackRoll.natural;
  const crit = nat === 20;
  const hit = crit || (nat !== 1 && attackRoll.total >= target.defense);
  const damageRoll = hit ? rollDice(attack.damage || '1d4', { rng, critical: crit }) : null;
  return { attackRoll, hit, crit, damageRoll, damage: damageRoll ? Math.max(0, damageRoll.total) : 0 };
}
