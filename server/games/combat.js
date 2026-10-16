import { rollDice } from '../dice.js';
import { effectsOf, removeEffect } from './status.js';
import { roleOf } from './roles.js';

export function phaseDurationEnd(state, now) {
  const s = state.combat.timerSeconds;
  return s > 0 ? now + s * 1000 : null;
}

export function startCombat(state, now) {
  state.combat.active = true;
  state.combat.phase = 'player';
  state.combat.round = 1;
  state.combat.phaseSeq = 1;
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
  c.phaseSeq = (c.phaseSeq ?? 1) + 1;
  c.phaseEndsAt = phaseDurationEnd(state, now);
  state.turn = {};
}

export function endCombat(state) {
  Object.assign(state.combat, { active: false, phase: null, round: 0, phaseSeq: 0, phaseEndsAt: null });
  state.turn = {};
}

// Tank heroes take 1/n of incoming damage (n = role strength), rounded down, at least 1 for any
// positive hit. Integer division avoids floating-point surprises with ⅓ and ⅕.
export function reduceIncoming(e, amount) {
  amount = Math.max(0, Math.floor(amount));
  const n = roleOf(e)?.damageTakenDivisor;
  if (amount > 0 && n > 1) return Math.max(1, Math.floor(amount / n));
  return amount;
}

// HP at which a creature truly dies: monsters at 0, PCs and NPCs at -maxHp.
export const deathAt = (e) => (e.kind === 'monster' ? 0 : -e.maxHp);

// Returns the resulting status transition, if any. PCs and NPCs go DOWN at 0 HP, keep taking
// damage into negative HP, and die at -maxHp. Monsters die at 0 HP.
export function applyDamage(e, amount) {
  amount = Math.max(0, Math.floor(amount));
  const before = e.status;
  if (e.status === 'dead') return { before, after: before };
  e.hp = Math.max(deathAt(e), e.hp - amount);
  if (e.hp <= deathAt(e)) e.status = 'dead';
  else if (e.hp <= 0) e.status = 'down';
  return { before, after: e.status };
}

// Negative HP is only a buffer before true death: any real heal first resets it to 0, then adds
// the full amount, so a downed creature always gets up with exactly what it was healed for.
// `healed` counts from 0, not from the negative number.
export function applyHeal(e, amount) {
  amount = Math.max(0, Math.floor(amount));
  const before = e.status;
  if (e.status === 'dead') return { before, after: before, healed: 0 };
  if (amount > 0 && e.hp < 0) e.hp = 0;
  const old = e.hp;
  e.hp = Math.min(e.maxHp, e.hp + amount);
  if (e.status === 'down' && e.hp > 0) e.status = 'active';
  return { before, after: e.status, healed: e.hp - old };
}

// DM override: HP above 0 brings a downed or dead creature back; 0 or below downs it; -maxHp kills.
export function setHp(e, value) {
  e.hp = Math.max(deathAt(e), Math.min(e.maxHp, Math.floor(value)));
  if (e.hp > 0) e.status = 'active';
  else if (e.hp <= deathAt(e)) e.status = 'dead';
  else e.status = 'down';
}

export function revive(e) {
  e.status = 'active';
  e.hp = Math.max(1, e.hp);
}

export function kill(e) {
  e.status = 'dead';
  e.hp = deathAt(e);
}

// ---------- shared attack / damage / heal pipeline ----------
// Every damage source (weapon attacks, abilities, area/chain/multi attacks, enemy attacks, the
// DM's Damage button) goes through dealDamage(); every heal goes through healTarget().

export const MAGICAL_TYPES = new Set(['fire', 'cold', 'frost', 'lightning', 'thunder', 'radiant', 'holy', 'necrotic', 'shadow', 'arcane', 'force', 'psychic', 'poison', 'acid', 'nature']);
export const isMagical = (damageType) => !!damageType && MAGICAL_TYPES.has(String(damageType).toLowerCase());

// To-hit penalties from statuses on the attacker.
const STATUS_TO_HIT = { frightened: -2, shaken: -2, poisoned: -2 };

export function effectiveDefense(target, defenseReduction = 0) {
  const bonus = effectsOf(target, 'defense_bonus').reduce((s, fx) => s + (fx.params.amount ?? 0), 0);
  return Math.max(0, (target.defense ?? 10) + bonus - Math.max(0, defenseReduction));
}

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

// Rolls `expr` against the target's effective Defense with every modifier applied once:
// flat attackBonus, the attacker's one-shot roll bonuses (Inspire, Foresight; consumed), status
// penalties (frightened, shaken, poisoned), the target's discourage_attacks penalty (Sanctuary), and the
// target's "next attack against self" Defense bonus (Serene Focus; consumed).
// Natural 20 always hits (crit); natural 1 always misses.
export function attackRoll(ctx, { source, target, expr, attackBonus = 0, defenseReduction = 0 }) {
  const mods = [];
  if (attackBonus) mods.push({ label: 'bonus', value: attackBonus });
  if (source) {
    for (const fx of effectsOf(source, 'grant_roll_bonus')) {
      const b = /d/i.test(String(fx.params.bonus)) ? rollDice(String(fx.params.bonus), { rng: ctx.rng }).total : Number(fx.params.bonus) || 0;
      mods.push({ label: fx.label, value: b });
      removeEffect(source, fx.id);
    }
    const penalized = new Set(); // each status counts once, however many copies are on the source
    for (const fx of source.effects ?? []) {
      if (!STATUS_TO_HIT[fx.status] || penalized.has(fx.status)) continue;
      penalized.add(fx.status);
      mods.push({ label: fx.label, value: STATUS_TO_HIT[fx.status] });
    }
  }
  for (const fx of effectsOf(target, 'discourage_attacks')) mods.push({ label: fx.label, value: -(fx.params.penalty ?? 5) });
  const defense = effectiveDefense(target, defenseReduction);
  const roll = rollDice(expr || '1d20', { rng: ctx.rng });
  const total = roll.total + mods.reduce((s, m) => s + m.value, 0);
  const nat = roll.natural;
  const crit = nat === 20;
  const hit = crit || (nat !== 1 && total >= defense);
  for (const fx of effectsOf(target, 'defense_bonus')) if (fx.trigger === 'next_attack_against_self') removeEffect(target, fx.id);
  const text = mods.length ? `${roll.text} ${mods.map((m) => `${signed(m.value)} ${m.label}`).join(' ')} → ${total}` : roll.text;
  return { roll, total, mods, defense, hit, crit, nat, text };
}

const consumable = (fx) => ['next_hit', 'until_next_hit', 'until_used', 'next_magical_hit'].includes(fx.trigger);

// Damage resolution order (each step applies at most once per hit):
//   1. raw rolled damage (crits already doubled the dice)
//   2. attacker modifiers: modify_damage_dealt (e.g. Curse of Weakness halves; applies to every hit
//      of one ability, then it's used up), Hunter's Mark dice
//   3. attacker role: DPS player characters deal n× (role strength; before the target's defenses)
//   4. redirection (Intercept): the protector becomes the victim
//   5. victim protection: absorb_next_hit (negates) or grant_protection (reduces), then
//      modify_damage_received
//   6. tank mitigation (1/n, min 1)
//   7. apply: training dummies only record the damage; everyone else goes through applyDamage
export function dealDamage(ctx, { source = null, target, raw, damageType = null, color = null }) {
  const notes = [];
  let amount = Math.max(0, Math.floor(raw));
  if (source && amount > 0) {
    for (const fx of effectsOf(source, 'modify_damage_dealt')) {
      if (fx.params.multiplier !== undefined) amount = Math.floor(amount * fx.params.multiplier);
      if (fx.params.amount) amount = Math.max(0, amount + fx.params.amount);
      notes.push(fx.label);
      // Inside an ability, "your next hit" covers every hit of that ability (all enemies of an
      // area or chain attack, every strike of a multi-attack); runAbility removes it afterwards.
      if (consumable(fx)) {
        if (ctx.spendAfterAbility) ctx.spendAfterAbility.push({ entity: source, id: fx.id });
        else removeEffect(source, fx.id);
      }
    }
    for (const fx of effectsOf(target, 'mark_target')) {
      if (fx.source?.entityId !== source.id) continue;
      const bonus = rollDice(String(fx.params.bonus ?? '1d6'), { rng: ctx.rng }).total;
      amount += bonus;
      notes.push(`+${bonus} ${fx.label}`);
      removeEffect(target, fx.id);
    }
    const mult = roleOf(source)?.damageDealtMultiplier;
    if (mult > 1 && amount > 0) {
      amount = Math.floor(amount * mult);
      notes.push(`×${mult} DPS`);
    }
  }
  let victim = target;
  const redirect = effectsOf(target, 'redirect_next_hit')[0];
  if (redirect && amount > 0) {
    removeEffect(target, redirect.id);
    const protector = ctx.state.entities[redirect.params.protectorId];
    const sid = ctx.state.activeSceneId;
    if (protector && protector.status === 'active' && (protector.scope === 'game' || protector.sceneId === sid)) {
      victim = protector;
      notes.push(`intercepted by ${protector.name}`);
    }
  }
  const magical = isMagical(damageType);
  if (amount > 0) {
    const absorb = effectsOf(victim, 'absorb_next_hit').find((fx) => !fx.params.magicalOnly || magical);
    if (absorb) {
      amount = 0;
      notes.push(`absorbed by ${absorb.label}`);
      removeEffect(victim, absorb.id);
    } else {
      const shield = effectsOf(victim, 'grant_protection').find((fx) => !fx.params.magicalOnly || magical);
      if (shield) {
        amount = shield.params.amount
          ? Math.max(0, amount - shield.params.amount)
          : Math.floor(amount * (1 - (shield.params.fraction ?? 0.5)));
        notes.push(`reduced by ${shield.label}`);
        removeEffect(victim, shield.id);
      }
    }
  }
  if (amount > 0) {
    for (const fx of effectsOf(victim, 'modify_damage_received')) {
      if (fx.params.multiplier !== undefined) amount = Math.floor(amount * fx.params.multiplier);
      if (fx.params.amount) amount = Math.max(0, amount + fx.params.amount);
      notes.push(fx.label);
      if (consumable(fx)) removeEffect(victim, fx.id);
    }
  }
  const preTank = amount;
  amount = reduceIncoming(victim, amount);
  if (amount !== preTank) notes.push('reduced by Tank');

  let change;
  if (victim.immortal) {
    victim.damageTaken = (victim.damageTaken ?? 0) + amount;
    victim.hits = (victim.hits ?? 0) + 1;
    change = { before: victim.status, after: victim.status };
  } else {
    change = applyDamage(victim, amount);
  }
  const blocked = amount === 0 && raw > 0;
  ctx.fx({ kind: blocked ? 'miss' : 'damage', entityId: victim.id, text: blocked ? 'BLOCKED' : `-${amount}`, color });
  return { victim, dealt: amount, raw: Math.max(0, Math.floor(raw)), notes, change };
}

// Healing order: rolled amount → ×n if the healer is a Heal-role player character → flat bonuses
// from the caster (Beacon of Grace; consumed) → applyHeal (negative HP resets to 0, clamp to max HP,
// downed recovery).
// Dead targets, training dummies and objects can't be healed. roleBonus: false skips the Heal
// role multiplier (item heals such as potions are flat).
export function healTarget(ctx, { source = null, target, amount, color = null, roleBonus = true }) {
  if (target.immortal || target.kind === 'object' || target.maxHp === null) return { healed: 0, skipped: `${target.name} can't be healed` };
  if (target.status === 'dead') return { healed: 0, skipped: `${target.name} is dead` };
  const notes = [];
  let total = Math.max(0, Math.floor(amount));
  const mult = roleBonus ? roleOf(source)?.healingDoneMultiplier : null;
  if (mult > 1 && total > 0) {
    total = Math.floor(total * mult);
    notes.push(`×${mult} Heal`);
  }
  if (source) {
    for (const fx of effectsOf(target, 'modify_healing')) {
      if (fx.source?.entityId !== source.id) continue;
      total += fx.params.amount ?? 0;
      notes.push(`+${fx.params.amount ?? 0} ${fx.label}`);
      removeEffect(target, fx.id);
    }
  }
  const change = applyHeal(target, total);
  ctx.fx({ kind: 'heal', entityId: target.id, text: `+${change.healed}`, color });
  return { healed: change.healed, change, notes };
}
