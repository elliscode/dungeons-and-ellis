import { rollDice, isValidDice } from '../dice.js';
import { fail, newId, areEnemies, areAllies, sideOf, footprintDistance, turnFor } from './state.js';
import { inBounds } from './placement.js';
import { addEffect, effectsOf, removeEffect, isValidDuration, TRIGGERS, tickEffects, computeExpiry } from './status.js';
import { attackRoll, dealDamage, healTarget } from './combat.js';
import * as H from './helpers.js';

// Shared, server-authoritative ability effect engine. Abilities are { id, name, description,
// actionCost, range, usesPerPhase?, effects: [...] }. Every effect type below has a validator and
// a handler; mechanics never come from descriptions. See docs/ABILITIES.md.

export const STATUSES = {
  frightened: { label: 'Frightened', icon: '😨' }, // can't move closer to its source
  snared: { label: 'Snared', icon: '🕸️' }, // movement 0
  shaken: { label: 'Shaken', icon: '💢' }, // -2 to hit
  poisoned: { label: 'Poisoned', icon: '🤢' }, // -2 to hit
  slowed: { label: 'Slowed', icon: '🐌' }, // label for negative movement modifiers
};

export const TARGETS = ['self', 'enemy', 'ally', 'ally_or_self', 'cell', 'enemies_in_area', 'allies_in_area', 'hit_enemies', 'checked_enemy', 'target'];
export const WHEN = ['attack_hits', 'attack_misses'];

// ---------- registry ----------
// spec: dice fields, numeric ranges, enum fields, required fields, default target.
const R = (min, max) => ({ min, max });
export const SPECS = {
  attack: { target: 'enemy', dice: ['attack', 'damage'], required: ['attack', 'damage'], nums: { range: R(0, 30), attackBonus: R(-10, 10), defenseReduction: R(0, 20), damageBonus: R(-20, 50) } },
  multi_attack: { target: 'enemy', dice: ['attack', 'damage'], required: ['attack', 'damage', 'count'], nums: { count: R(2, 10), range: R(0, 30), attackBonus: R(-10, 10), damageBonus: R(-20, 50) } },
  area_attack: { target: 'enemies_in_area', dice: ['attack', 'damage'], required: ['attack', 'damage'], nums: { radius: R(0, 10), range: R(0, 30), attackBonus: R(-10, 10), damageBonus: R(-20, 50) }, enums: { center: ['self', 'target'] } },
  chain_attack: { target: 'enemy', dice: ['attack', 'damage'], required: ['attack', 'damage', 'jumps'], nums: { jumps: R(1, 5), jumpRange: R(1, 20), range: R(0, 30) } },
  heal: { target: 'ally_or_self', dice: ['heal'], required: ['heal'], nums: { range: R(0, 30) } },
  chain_heal: { target: 'ally_or_self', dice: ['heal'], required: ['heal', 'jumps'], nums: { jumps: R(1, 5), jumpRange: R(1, 20), range: R(0, 30) } },
  modify_healing: { target: 'ally_or_self', required: ['amount'], nums: { amount: R(1, 50), range: R(0, 30) } },
  grant_protection: { target: 'self', nums: { amount: R(1, 100), fraction: R(0.05, 1), range: R(0, 30) } },
  absorb_next_hit: { target: 'self', nums: { range: R(0, 30) } },
  redirect_next_hit: { target: 'ally', nums: { range: R(0, 30) } },
  defense_bonus: { target: 'self', required: ['amount'], nums: { amount: R(-10, 10), range: R(0, 30), radius: R(0, 10) } },
  modify_damage_received: { target: 'self', nums: { amount: R(-50, 50), multiplier: R(0, 5) } },
  modify_damage_dealt: { target: 'self', nums: { amount: R(-50, 50), multiplier: R(0, 5) } },
  modify_movement: { target: 'self', required: ['amount'], nums: { amount: R(-20, 20) } },
  taunt: { target: 'enemy', nums: { radius: R(0, 10) } },
  reduce_actions: { target: 'enemy', nums: { amount: R(1, 5) } },
  mark_target: { target: 'enemy', dice: ['bonus'], nums: { range: R(0, 30) } },
  grant_roll_bonus: { target: 'ally_or_self', required: ['bonus'], nums: { range: R(0, 30) } },
  apply_status: { target: 'enemy', required: ['status'], enums: { status: Object.keys(STATUSES) } },
  remove_status: { target: 'ally_or_self', required: ['status'], enums: { status: Object.keys(STATUSES) } },
  discourage_attacks: { target: 'ally_or_self', nums: { penalty: R(1, 10), range: R(0, 30) } },
  grant_actions: { target: 'self', required: ['amount'], nums: { amount: R(1, 3) } },
  teleport: { target: 'cell', required: ['distance'], nums: { distance: R(1, 30) } },
  narrative: { target: 'self', dice: ['roll'] },
  create_barrier: { target: 'cell', nums: { range: R(0, 10) } },
  healing_aura: { target: 'cell', dice: ['heal'], required: ['heal'], nums: { radius: R(0, 10), pulses: R(1, 10), range: R(0, 10) } },
  roll_to_apply: { target: 'enemy', dice: ['roll'], required: ['roll', 'onSuccess'], nums: { radius: R(0, 10), range: R(0, 30) } },
  dm_check: { target: 'enemy', dice: ['roll'], required: ['roll'] },
};
export const EFFECT_TYPES = Object.keys(SPECS);

function validateEffect(eff, at, errors, depth = 0) {
  const err = (m) => errors.push(`${at}: ${m}`);
  if (!eff || typeof eff !== 'object') return err('must be an object');
  const spec = SPECS[eff.type];
  if (!spec) return err(`unknown effect type "${eff.type}" (known: ${EFFECT_TYPES.join(', ')})`);
  if (eff.target !== undefined && !TARGETS.includes(eff.target)) err(`target must be one of ${TARGETS.join(', ')}`);
  if (eff.when !== undefined && !WHEN.includes(eff.when)) err(`when must be one of ${WHEN.join(', ')}`);
  if (!isValidDuration(eff.duration)) err('duration must be current_turn, until_next_player_phase, next_dm_phase, combat, until_used or { "phases": N }');
  if (eff.trigger !== undefined && !TRIGGERS.includes(eff.trigger)) err(`trigger must be one of ${TRIGGERS.join(', ')}`);
  for (const k of spec.required ?? []) if (eff[k] === undefined || eff[k] === null || eff[k] === '') err(`${k} is required`);
  for (const k of spec.dice ?? []) if (eff[k] !== undefined && eff[k] !== null && !isValidDice(eff[k])) err(`${k} "${eff[k]}" is not valid dice`);
  if (eff.type === 'grant_roll_bonus' && eff.bonus !== undefined && !isValidDice(String(eff.bonus)) && !Number.isInteger(eff.bonus)) err('bonus must be dice (e.g. 1d6) or a whole number');
  for (const [k, r] of Object.entries(spec.nums ?? {})) {
    if (eff[k] === undefined) continue;
    if (typeof eff[k] !== 'number' || !Number.isFinite(eff[k]) || eff[k] < r.min || eff[k] > r.max) err(`${k} must be a number from ${r.min} to ${r.max}`);
  }
  for (const [k, vals] of Object.entries(spec.enums ?? {})) if (eff[k] !== undefined && !vals.includes(eff[k])) err(`${k} must be one of ${vals.join(', ')}`);
  for (const k of ['onSuccess', 'onFailure']) {
    if (eff[k] === undefined) continue;
    if (!Array.isArray(eff[k])) { err(`${k} must be an array of effects`); continue; }
    if (depth > 2) { err('effects are nested too deeply'); continue; }
    eff[k].forEach((sub, i) => validateEffect(sub, `${at}.${k}[${i}]`, errors, depth + 1));
  }
}

// Converts legacy ability fields (attack/damage/heal/roll/free/grantsActions) into the canonical
// schema. Idempotent: canonical abilities pass through with defaults filled in.
export function normalizeAbility(a) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a };
  out.actionCost = Number.isInteger(a.actionCost) ? a.actionCost : a.free === true || a.grantsActions ? 0 : 1;
  if (Array.isArray(a.effects) && a.effects.length) {
    out.effects = a.effects;
  } else {
    const eff = [];
    if (a.attack && a.damage) {
      eff.push({ type: 'attack', target: 'enemy', attack: a.attack, damage: a.damage, range: a.range ?? 1 });
      if (a.heal) eff.push({ type: 'heal', target: 'self', heal: a.heal, when: 'attack_hits' });
    } else if (a.heal) {
      eff.push({ type: 'heal', target: a.range === 0 ? 'self' : 'ally_or_self', heal: a.heal, range: a.range ?? 1 });
    }
    if (a.grantsActions) eff.push({ type: 'grant_actions', target: 'self', amount: a.grantsActions });
    if (!eff.length) eff.push({ type: 'narrative', ...(a.roll ? { roll: a.roll } : {}) });
    out.effects = eff;
  }
  if (a.grantsActions && out.usesPerPhase === undefined) out.usesPerPhase = 1;
  if (!Number.isFinite(out.range)) out.range = out.effects.find((e) => Number.isFinite(e.range))?.range ?? 0;
  return out;
}

// Validates one ability (after normalization). Used by the content loader for every definition.
export function validateAbility(raw, at) {
  const errors = [];
  const a = normalizeAbility(raw);
  if (!Number.isInteger(a.actionCost) || a.actionCost < 0 || a.actionCost > 5) errors.push(`${at}: actionCost must be 0-5`);
  if (a.usesPerPhase !== undefined && !(Number.isInteger(a.usesPerPhase) && a.usesPerPhase >= 1 && a.usesPerPhase <= 10)) errors.push(`${at}: usesPerPhase must be 1-10`);
  if (!Number.isFinite(a.range) || a.range < 0 || a.range > 30) errors.push(`${at}: range must be 0-30`);
  a.effects.forEach((eff, i) => validateEffect(eff, `${at}.effects[${i}]`, errors));
  const grants = a.effects.filter((e) => e.type === 'grant_actions').reduce((s, e) => s + (e.amount ?? 0), 0);
  if (grants && !a.usesPerPhase) errors.push(`${at}: abilities that grant actions need usesPerPhase`);
  if (grants > a.actionCost + 1) errors.push(`${at}: may grant at most actionCost + 1 actions`);
  return errors;
}

// Abilities that deal damage are combat-only, like weapon attacks. Debuffs, heals, buffs,
// movement and narrative abilities stay usable while exploring.
const DAMAGE_EFFECTS = new Set(['attack', 'multi_attack', 'area_attack', 'chain_attack']);
export function dealsDamage(raw) {
  const walk = (effects) => (effects ?? []).some((e) => DAMAGE_EFFECTS.has(e.type) || walk(e.onSuccess) || walk(e.onFailure));
  return walk(normalizeAbility(raw)?.effects);
}

const effTarget = (eff) => eff.target ?? SPECS[eff.type]?.target ?? 'self';

// What the client must pick before activating: an enemy, an ally, a cell, or nothing.
export function targetingOf(raw) {
  const a = normalizeAbility(raw);
  for (const eff of a.effects) {
    const t = effTarget(eff);
    const range = eff.range ?? a.range ?? 1;
    const chain = eff.type === 'chain_attack' || eff.type === 'chain_heal' ? { jumps: eff.jumps, jumpRange: eff.jumpRange ?? 3 } : null;
    if (t === 'enemy' || t === 'target' || (eff.type === 'area_attack' && eff.center === 'target')) return { kind: 'enemy', range, chain };
    if (t === 'ally') return { kind: 'ally', range, includeSelf: false, chain };
    if (t === 'ally_or_self') return { kind: 'ally', range, includeSelf: true, chain };
    if (t === 'cell') return { kind: 'cell', range: eff.distance ?? eff.range ?? a.range ?? 1 };
  }
  return { kind: 'none', range: 0 };
}

// ---------- target helpers ----------

const alive = (e) => e && e.status !== 'dead' && e.kind !== 'object';

function sceneEntities(ctx) {
  return Object.values(ctx.state.entities).filter((e) => H.inScene(e, ctx.state.activeSceneId) && e.positions[ctx.state.activeSceneId]);
}

function areaTargets(ctx, act, eff, wantAllies) {
  const center = eff.center === 'target' ? act.primary : act.caster;
  if (!center) return [];
  const radius = eff.radius ?? 1;
  return sceneEntities(ctx)
    .filter((e) => alive(e) && (wantAllies ? areAllies(act.caster, e) && (e !== act.caster || eff.includeSelf !== false) : areEnemies(act.caster, e)))
    .filter((e) => H.distanceBetween(ctx, center, e) <= radius)
    .sort((a, b) => H.distanceBetween(ctx, center, a) - H.distanceBetween(ctx, center, b) || a.name.localeCompare(b.name));
}

function targetsFor(ctx, act, eff) {
  switch (effTarget(eff)) {
    case 'self': return [act.caster];
    case 'enemy': case 'ally': case 'ally_or_self': case 'target': return act.primary ? [act.primary] : [];
    case 'checked_enemy': return act.checked ? [act.checked] : act.primary ? [act.primary] : [];
    case 'hit_enemies': return act.hitEnemies;
    case 'enemies_in_area': return areaTargets(ctx, act, eff, false);
    case 'allies_in_area': return areaTargets(ctx, act, eff, true);
    default: return [];
  }
}

// Picked chain jumps: distinct, valid, each within jumpRange of the previous link.
function chainOf(ctx, act, eff, valid) {
  const links = [act.primary];
  const picks = Array.isArray(act.picks) ? act.picks.slice(0, eff.jumps) : [];
  if ((act.picks?.length ?? 0) > eff.jumps) fail(`${act.ability.name} can jump to at most ${eff.jumps} more target(s)`);
  for (const id of picks) {
    const t = ctx.state.entities[id];
    if (!t || !H.inScene(t, ctx.state.activeSceneId)) fail('A chain target is not in this scene');
    if (links.includes(t)) fail(`${t.name} is already in the chain`);
    const why = valid(t);
    if (why) fail(why);
    const prev = links[links.length - 1];
    if (H.distanceBetween(ctx, prev, t) > (eff.jumpRange ?? 3)) fail(`${t.name} is too far from ${prev.name} for the chain`);
    links.push(t);
  }
  return links;
}

const sourceOf = (act) => ({ entityId: act.caster.id, name: act.caster.name });

// One weapon or ability strike: attack roll, damage roll, shared damage pipeline.
export function strike(ctx, { attacker, target, attack, color }) {
  const r = attackRoll(ctx, {
    source: attacker, target, expr: attack.attack,
    attackBonus: attack.attackBonus ?? 0, defenseReduction: attack.defenseReduction ?? 0,
  });
  if (!r.hit) {
    ctx.fx({ kind: 'miss', entityId: target.id, text: 'MISS', color });
    return { hit: false, crit: false, dealt: 0, roll: r, victim: target, target };
  }
  if (r.crit) ctx.fx({ kind: 'crit', entityId: target.id, text: 'CRIT', color });
  const dmg = rollDice(attack.damage || '1d4', { rng: ctx.rng, critical: r.crit });
  const raw = Math.max(0, dmg.total + (attack.damageBonus ?? 0));
  const d = dealDamage(ctx, { source: attacker, target, raw, damageType: attack.damageType, color });
  return { hit: true, crit: r.crit, dealt: d.dealt, raw, roll: r, dmg, notes: d.notes, change: d.change, victim: d.victim, target, suffix: H.statusSuffix(d.victim, d.change) };
}

// Compact public text for one strike, e.g. "HIT 7" / "CRIT 14" / "MISS".
function strikeWord(s) {
  if (!s.hit) return 'MISS';
  const notes = s.notes?.length ? ` (${s.notes.join(', ')})` : '';
  const via = s.victim !== s.target ? ` → ${s.victim.name}` : '';
  return `${s.crit ? 'CRIT' : 'HIT'} ${s.dealt}${notes}${via}`;
}

function line(act, pub, dm = pub) {
  act.lines.push({ pub, dm });
}

function recordStrikes(ctx, act, strikes) {
  for (const s of strikes) {
    act.data.strikes.push({ targetId: s.target.id, victimId: s.victim.id, hit: s.hit, crit: s.crit, dealt: s.dealt });
    if (s.hit && !act.hitEnemies.includes(s.target)) act.hitEnemies.push(s.target);
  }
  if (strikes.length) act.lastHit = strikes.some((s) => s.hit);
  // Status changes and HP notes for every distinct victim.
  for (const v of [...new Set(strikes.map((s) => s.victim))]) {
    const suffix = strikes.filter((s) => s.victim === v).map((s) => s.suffix).filter(Boolean).join('');
    const t = H.hpTexts(v);
    if (suffix || t.pub || t.dm) line(act, `${suffix.trim()}${t.pub}`.trim(), `${suffix.trim()}${t.dm}`.trim());
  }
}

const attackOf = (eff, name) => ({
  name, attack: eff.attack, damage: eff.damage, attackBonus: eff.attackBonus, defenseReduction: eff.defenseReduction,
  damageBonus: eff.damageBonus, damageType: eff.damageType,
});

// Applies a live effect (buff, debuff, protection, mark, status) to each target.
function applyLive(ctx, act, eff, targets, { icon, trigger, duration, params = {}, status = null, label } = {}) {
  for (const t of targets) {
    if (!t || t.kind === 'object') continue;
    addEffect(ctx.state, t, {
      type: eff.type, label: eff.label ?? label ?? act.ability.name, icon: eff.icon ?? icon, status: eff.status ?? status,
      source: sourceOf(act), params, trigger: eff.trigger ?? trigger, duration: eff.duration ?? duration,
    });
  }
  if (targets.length) line(act, `${targets.map((t) => t.name).join(', ')} ${targets.length > 1 ? 'gain' : 'gains'} ${eff.label ?? label ?? act.ability.name}`);
}

// ---------- handlers ----------

const HANDLERS = {
  attack(ctx, act, eff) {
    const [target] = targetsFor(ctx, act, eff);
    if (!target) return;
    const s = strike(ctx, { attacker: act.caster, target, attack: attackOf(eff, act.ability.name), color: ctx.actorColor });
    line(act, `${target.name}: ${strikeWord(s)} (${s.roll.text}${s.dmg ? `; ${s.dmg.text}` : ''})`,
      `${target.name}: ${strikeWord(s)} (${s.roll.text} vs DEF ${s.roll.defense}${s.dmg ? `; ${s.dmg.text}` : ''})`);
    recordStrikes(ctx, act, [s]);
  },

  // Independent strikes: each has its own attack roll and, on a hit, its own damage roll.
  multi_attack(ctx, act, eff) {
    const [target] = targetsFor(ctx, act, eff);
    if (!target) return;
    const strikes = [];
    for (let i = 0; i < eff.count; i++) {
      if (target.status === 'dead') break; // remaining strikes are lost once the target dies
      strikes.push(strike(ctx, { attacker: act.caster, target, attack: attackOf(eff, act.ability.name), color: ctx.actorColor }));
    }
    const total = strikes.reduce((s, x) => s + x.dealt, 0);
    line(act, `${strikes.length} strikes on ${target.name}: ${strikes.map(strikeWord).join(' · ')} — ${total} total`,
      `${strikes.length} strikes on ${target.name} (DEF ${strikes[0]?.roll.defense}): ${strikes.map((s) => `${strikeWord(s)} [${s.roll.total}]`).join(' · ')} — ${total} total`);
    recordStrikes(ctx, act, strikes);
  },

  area_attack(ctx, act, eff) {
    const targets = targetsFor(ctx, act, eff.target === undefined ? { ...eff, target: 'enemies_in_area' } : eff);
    if (!targets.length) { line(act, 'no enemies in the area'); act.lastHit = false; return; }
    const strikes = targets.map((t) => strike(ctx, { attacker: act.caster, target: t, attack: attackOf(eff, act.ability.name), color: ctx.actorColor }));
    line(act, strikes.map((s) => `${s.target.name} ${strikeWord(s)}`).join(', '));
    recordStrikes(ctx, act, strikes);
  },

  chain_attack(ctx, act, eff) {
    const links = chainOf(ctx, act, eff, (t) => (!alive(t) ? `${t.name} can't be targeted` : !areEnemies(act.caster, t) ? `${t.name} is not an enemy` : null));
    const strikes = links.map((t) => strike(ctx, { attacker: act.caster, target: t, attack: attackOf(eff, act.ability.name), color: ctx.actorColor }));
    line(act, strikes.map((s) => `${s.target.name} ${strikeWord(s)}`).join(' ⚡ '));
    recordStrikes(ctx, act, strikes);
  },

  heal(ctx, act, eff) {
    for (const t of targetsFor(ctx, act, eff)) healOne(ctx, act, eff, t);
  },

  chain_heal(ctx, act, eff) {
    const links = chainOf(ctx, act, eff, (t) => {
      if (!areAllies(act.caster, t) && t !== act.caster) return `${t.name} is not an ally`;
      if (t.immortal || t.maxHp === null || t.status === 'dead') return `${t.name} can't be healed`;
      if (t.hp >= t.maxHp) return `${t.name} isn't wounded`;
      return null;
    });
    for (const t of links) healOne(ctx, act, eff, t);
  },

  modify_healing(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: '💛', trigger: 'until_next_heal_by_caster', params: { amount: eff.amount } });
  },

  grant_protection(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), {
      icon: '🛡️', trigger: 'next_hit', duration: 'next_dm_phase',
      params: { amount: eff.amount, fraction: eff.fraction ?? (eff.amount ? undefined : 0.5), magicalOnly: !!eff.magicalOnly },
    });
  },

  absorb_next_hit(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), {
      icon: '🛡️', trigger: eff.magicalOnly ? 'next_magical_hit' : 'next_hit', duration: 'next_dm_phase', params: { magicalOnly: !!eff.magicalOnly },
    });
  },

  // Placed on the protected ally: their next incoming hit lands on the caster instead.
  redirect_next_hit(ctx, act, eff) {
    const targets = targetsFor(ctx, act, eff).filter((t) => t !== act.caster);
    applyLive(ctx, act, eff, targets, { icon: '🤝', trigger: 'next_hit', duration: 'next_dm_phase', params: { protectorId: act.caster.id }, label: `${eff.label ?? act.ability.name} (${act.caster.name})` });
  },

  defense_bonus(ctx, act, eff) {
    const targets = eff.radius !== undefined ? [act.caster, ...areaTargets(ctx, act, { radius: eff.radius, includeSelf: false }, true)] : targetsFor(ctx, act, eff);
    applyLive(ctx, act, eff, [...new Set(targets)], {
      icon: eff.amount >= 0 ? '🛡️' : '🔻', duration: 'until_next_player_phase', params: { amount: eff.amount },
      label: `${eff.label ?? act.ability.name} (${eff.amount >= 0 ? '+' : ''}${eff.amount} DEF)`,
    });
  },

  modify_damage_received(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: eff.amount > 0 || eff.multiplier > 1 ? '🔻' : '🛡️', duration: 'next_dm_phase', params: { amount: eff.amount, multiplier: eff.multiplier } });
  },

  modify_damage_dealt(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: eff.amount < 0 || eff.multiplier < 1 ? '🥀' : '💪', trigger: 'next_hit', duration: 'next_dm_phase', params: { amount: eff.amount, multiplier: eff.multiplier } });
  },

  modify_movement(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), {
      icon: eff.amount < 0 ? '🐌' : '💨', status: eff.amount < 0 ? 'slowed' : null, duration: 'next_dm_phase', params: { amount: eff.amount },
      label: `${eff.label ?? act.ability.name} (${eff.amount > 0 ? '+' : ''}${eff.amount} move)`,
    });
  },

  taunt(ctx, act, eff) {
    const targets = eff.radius !== undefined ? areaTargets(ctx, act, { radius: eff.radius }, false) : targetsFor(ctx, act, eff);
    applyLive(ctx, act, eff, targets, { icon: '📣', duration: 'next_dm_phase', params: { tauntedBy: act.caster.id }, label: `Taunted by ${act.caster.name}` });
  },

  reduce_actions(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: '⏳', duration: 'next_dm_phase', params: { amount: eff.amount ?? 1 }, label: `${eff.label ?? act.ability.name} (−${eff.amount ?? 1} action)` });
  },

  mark_target(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: '🎯', trigger: 'until_used', params: { bonus: eff.bonus ?? '1d6' } });
  },

  grant_roll_bonus(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: '✨', trigger: 'until_used', params: { bonus: eff.bonus } });
  },

  apply_status(ctx, act, eff) {
    const st = STATUSES[eff.status];
    applyLive(ctx, act, { ...eff, status: eff.status, label: eff.label ?? st.label }, targetsFor(ctx, act, eff), {
      icon: st.icon, duration: 'next_dm_phase', params: { sourceId: act.caster.id },
    });
  },

  remove_status(ctx, act, eff) {
    for (const t of targetsFor(ctx, act, eff)) {
      const gone = (t.effects ?? []).filter((fx) => fx.status === eff.status);
      for (const fx of gone) removeEffect(t, fx.id);
      line(act, gone.length ? `${t.name} is no longer ${STATUSES[eff.status].label.toLowerCase()}` : `${t.name} wasn't ${STATUSES[eff.status].label.toLowerCase()}`);
    }
  },

  discourage_attacks(ctx, act, eff) {
    applyLive(ctx, act, eff, targetsFor(ctx, act, eff), { icon: '🕊️', duration: 'next_dm_phase', params: { penalty: eff.penalty ?? 5 } });
  },

  grant_actions(ctx, act, eff) {
    if (!H.budgeted(ctx, act.caster)) { line(act, '(extra actions only matter in combat)'); return; }
    turnFor(ctx.state, act.caster.id).bonus += eff.amount;
    line(act, `+${eff.amount} action${eff.amount > 1 ? 's' : ''}`);
  },

  teleport(ctx, act, eff) {
    const c = act.cell;
    act.caster.positions[act.scene.id] = { x: c.x, y: c.y };
    act.caster.z = ++ctx.state.zCounter;
    line(act, `${act.caster.name} teleports`);
  },

  narrative(ctx, act, eff) {
    if (!eff.roll) return;
    const r = H.rollOrFail(eff.roll, ctx);
    line(act, `rolls ${eff.roll}: ${r.text}`);
  },

  create_barrier(ctx, act, eff) {
    const e = spawnObject(ctx, act, eff, { name: eff.name ?? 'Barrier', icon: '🧱', duration: eff.duration ?? 'next_dm_phase' });
    line(act, `${e.name} placed`);
  },

  healing_aura(ctx, act, eff) {
    const e = spawnObject(ctx, act, eff, { name: eff.name ?? 'Healing Totem', icon: '🌿', duration: null });
    e.aura = { heal: eff.heal, radius: eff.radius ?? 2, pulses: eff.pulses ?? 2, side: sideOf(act.caster), sourceId: act.caster.id, sourceName: act.caster.name };
    line(act, `${e.name} placed (heals allies within ${e.aura.radius} at the start of the next ${e.aura.pulses} player phases)`);
  },

  // Roll against each subject's Defense; on success apply onSuccess to that subject.
  roll_to_apply(ctx, act, eff) {
    const subjects = eff.radius !== undefined ? areaTargets(ctx, act, { radius: eff.radius }, false) : targetsFor(ctx, act, eff);
    if (!subjects.length) { line(act, 'no targets'); return; }
    for (const s of subjects) {
      const r = attackRoll(ctx, { source: act.caster, target: s, expr: eff.roll });
      line(act, `${s.name}: ${r.hit ? 'success' : 'resisted'} (${r.text})`, `${s.name}: ${r.hit ? 'success' : 'resisted'} (${r.text} vs DEF ${r.defense})`);
      const outcome = r.hit ? eff.onSuccess : eff.onFailure;
      if (outcome?.length) runEffects(ctx, { ...act, checked: s, primary: s }, outcome);
    }
  },

  // The DM decides: create a pending check per subject; check.resolve applies the outcome.
  dm_check(ctx, act, eff) {
    const subjects = targetsFor(ctx, act, eff);
    if (!subjects.length) return;
    ctx.state.pendingChecks ??= [];
    for (const s of subjects) {
      const r = H.rollOrFail(eff.roll, ctx);
      ctx.state.pendingChecks.push({
        id: newId('chk'), casterId: act.caster.id, casterName: act.caster.name, abilityName: act.ability.name,
        subjectId: s.id, subjectName: s.name, roll: r.text, total: r.total,
        onSuccess: eff.onSuccess ?? [], onFailure: eff.onFailure ?? [], createdAt: ctx.now,
      });
      line(act, `${s.name}: rolled ${r.total} — awaiting the DM's call`);
    }
  },
};

for (const t of EFFECT_TYPES) if (!HANDLERS[t]) throw new Error(`effect type ${t} has no handler`);
export const HANDLED_TYPES = Object.keys(HANDLERS);

function healOne(ctx, act, eff, t) {
  const r = H.rollOrFail(eff.heal, ctx);
  const h = healTarget(ctx, { source: act.caster, target: t, amount: r.total, color: ctx.actorColor });
  if (h.skipped) { line(act, `${h.skipped}`); return; }
  const notes = h.notes.length ? ` (${h.notes.join(', ')})` : '';
  const ht = H.hpTexts(t);
  const sfx = H.statusSuffix(t, h.change);
  line(act, `${t.name} +${h.healed} (${r.text})${notes}.${sfx}${ht.pub}`, `${t.name} +${h.healed} (${r.text})${notes}.${sfx}${ht.dm}`);
}

function spawnObject(ctx, act, eff, { name, icon, duration }) {
  const id = newId('e');
  const e = {
    id, kind: 'object', defId: null, name, role: null, image: eff.image ?? null, size: { w: 1, h: 1 },
    maxHp: null, hp: null, defense: 0, movement: 0, attacks: [], abilities: [], inventory: [], effects: [],
    actionsPerPhase: 0, status: 'active', hostile: false, scope: 'scene', sceneId: act.scene.id,
    positions: { [act.scene.id]: { x: act.cell.x, y: act.cell.y } }, z: ++ctx.state.zCounter, ownerPlayerId: null,
    temporary: true, icon, expires: duration ? computeExpiry(ctx.state, duration) : { atSeq: null, pending: null, onCombatEnd: true },
    createdBy: act.caster.id,
  };
  ctx.state.entities[id] = e;
  return e;
}

// Count of handler executions per effect type (lets the test suite prove every type ran).
export const handlerCalls = new Map();

export function runEffects(ctx, act, effects) {
  for (const eff of effects) {
    if (eff.when === 'attack_hits' && act.lastHit !== true) continue;
    if (eff.when === 'attack_misses' && act.lastHit !== false) continue;
    handlerCalls.set(eff.type, (handlerCalls.get(eff.type) ?? 0) + 1);
    HANDLERS[eff.type](ctx, act, eff);
  }
}

// ---------- activation ----------

const usesThisPhase = (t, id) => (t?.abilitiesUsed ?? []).filter((x) => x === id).length;

export function activateAbility(ctx) {
  const e = H.controlled(ctx, ctx.cmd.entityId);
  const scene = H.onActiveScene(ctx, e);
  H.requireStatus(e, 'use abilities');
  H.requireActionWindow(ctx, e);
  const raw = (e.abilities ?? []).find((a) => a.id === ctx.cmd.abilityId);
  if (!raw) fail('Unknown ability');
  const ab = normalizeAbility(raw);
  if (!ctx.state.combat.active && dealsDamage(ab)) fail(`${ab.name} deals damage and is only available in combat`);
  const budget = H.budgeted(ctx, e);
  const t = budget ? turnFor(ctx.state, e.id) : null;
  if (t && ab.usesPerPhase && usesThisPhase(t, ab.id) >= ab.usesPerPhase) {
    fail(`${ab.name} can only be used ${ab.usesPerPhase === 1 ? 'once' : `${ab.usesPerPhase} times`} per phase`);
  }
  H.checkAction(ctx, e, ab.actionCost);

  const act = { caster: e, ability: ab, scene, primary: null, cell: null, picks: ctx.cmd.picks ?? [], checked: null, hitEnemies: [], lastHit: null, lines: [], data: { abilityId: ab.id, strikes: [] } };
  const tg = targetingOf(ab);
  if (tg.kind === 'enemy' || tg.kind === 'ally') {
    const targetId = ctx.cmd.targetId ?? (tg.kind === 'ally' && tg.includeSelf ? e.id : null);
    if (!targetId) fail(`${ab.name} needs a target`);
    const target = H.getEntity(ctx, targetId);
    H.onActiveScene(ctx, target);
    if (!alive(target)) fail(target.kind === 'object' ? `${target.name} can't be targeted` : `${target.name} is dead`);
    if (tg.kind === 'enemy' && !areEnemies(e, target)) fail(`${target.name} is not an enemy`);
    if (tg.kind === 'ally') {
      if (target === e && !tg.includeSelf) fail(`${ab.name} must target an ally`);
      if (target !== e && !areAllies(e, target)) fail(`${target.name} is not an ally`);
    }
    if (H.distanceBetween(ctx, e, target) > tg.range) fail(`${target.name} is out of range (${tg.range})`);
    checkTaunt(ctx, e, target);
    act.primary = target;
    if (target !== e) act.data.targetId = target.id;
  } else if (tg.kind === 'cell') {
    const x = Number(ctx.cmd.cell?.x), y = Number(ctx.cmd.cell?.y);
    if (!inBounds(scene, x, y, { w: 1, h: 1 })) fail('Pick a square on the map');
    const pos = e.positions[scene.id];
    if (footprintDistance(pos, e.size, { x, y }, { w: 1, h: 1 }) > tg.range) fail(`That square is out of range (${tg.range})`);
    if (ab.effects.some((x2) => x2.type === 'teleport') && !inBounds(scene, x, y, e.size)) fail('You would not fit there');
    act.cell = { x, y };
  }

  H.spendAction(ctx, e, ab.actionCost);
  if (t) t.abilitiesUsed.push(ab.id);
  runEffects(ctx, act, ab.effects);

  const on = act.primary && act.primary !== e ? ` on ${act.primary.name}` : '';
  const head = `${e.name} uses ${ab.name}${on}`;
  const pub = act.lines.map((l) => l.pub).filter(Boolean).join(' · ');
  const dm = act.lines.map((l) => l.dm).filter(Boolean).join(' · ');
  ctx.log('ability', pub ? `${head}: ${pub}` : head, { dmText: dm ? `${head}: ${dm}` : head, data: act.data });
  return { strikes: act.data.strikes };
}

// A taunted creature must attack its taunter while the taunter is a valid target in range.
export function checkTaunt(ctx, attacker, target) {
  for (const fx of effectsOf(attacker, 'taunt')) {
    const taunter = ctx.state.entities[fx.params.tauntedBy];
    if (!taunter || taunter === target || !alive(taunter) || !H.inScene(taunter, ctx.state.activeSceneId)) continue;
    if (areEnemies(attacker, target)) fail(`${attacker.name} is taunted by ${taunter.name} and must attack them`);
  }
}

// DM resolves a pending dm_check.
export function resolveCheck(ctx, checkId, success) {
  const list = ctx.state.pendingChecks ?? [];
  const i = list.findIndex((c) => c.id === checkId);
  if (i < 0) fail('That check was already resolved');
  const chk = list.splice(i, 1)[0];
  const subject = ctx.state.entities[chk.subjectId];
  const caster = ctx.state.entities[chk.casterId];
  const outcome = success ? chk.onSuccess : chk.onFailure;
  const verdict = `${chk.casterName}'s ${chk.abilityName} vs ${chk.subjectName} (rolled ${chk.total}): ${success ? 'SUCCESS' : 'FAILURE'}`;
  if (!subject || !caster || !outcome.length || !ctx.state.activeSceneId) {
    ctx.log('ability', verdict);
    return;
  }
  const act = { caster, ability: { name: chk.abilityName, id: null }, scene: ctx.state.scenes[ctx.state.activeSceneId], primary: subject, checked: subject, cell: null, picks: [], hitEnemies: [subject], lastHit: true, lines: [], data: { strikes: [] } };
  runEffects(ctx, act, outcome);
  const pub = act.lines.map((l) => l.pub).filter(Boolean).join(' · ');
  ctx.log('ability', pub ? `${verdict} — ${pub}` : verdict);
}

// ---------- lifecycle: called on every combat phase transition ----------

export function onPhaseTransition(ctx, transition) {
  const state = ctx.state;
  const expired = tickEffects(state, transition);
  // Temporary objects (barriers, totems).
  for (const e of Object.values(state.entities)) {
    if (!e.temporary) continue;
    const x = e.expires ?? {};
    if (transition === 'start' && x.pending) e.expires = computeExpiry(state, x.pending);
    const gone = transition === 'end' ? x.onCombatEnd : x.atSeq !== null && x.atSeq !== undefined && state.combat.phaseSeq >= x.atSeq;
    if (gone) {
      delete state.entities[e.id];
      expired.push({ entity: e, effect: { label: e.name } });
    }
  }
  // Healing auras pulse at the start of each PLAYER PHASE.
  if (transition === 'advance' && state.combat.phase === 'player') {
    for (const totem of Object.values(state.entities)) {
      if (!totem.aura || !H.inScene(totem, state.activeSceneId)) continue;
      const lines = [];
      for (const t of sceneEntities(ctx)) {
        if (!alive(t) || sideOf(t) !== totem.aura.side || H.distanceBetween(ctx, totem, t) > totem.aura.radius) continue;
        const r = H.rollOrFail(totem.aura.heal, ctx);
        const source = state.entities[totem.aura.sourceId] ?? null;
        const h = healTarget(ctx, { source, target: t, amount: r.total, color: null });
        if (!h.skipped) lines.push(`${t.name} +${h.healed}`);
      }
      totem.aura.pulses -= 1;
      if (lines.length) ctx.log('heal', `${totem.name} pulses: ${lines.join(', ')}`);
      if (totem.aura.pulses <= 0) delete state.entities[totem.id];
    }
  }
  const visible = expired.filter((x) => x.entity.status !== 'dead');
  if (visible.length) {
    ctx.log('effect', '', { dmText: `Effects ended: ${visible.map((x) => `${x.effect.label} (${x.entity.name})`).join(', ')}`, dmOnly: true });
  }
}
