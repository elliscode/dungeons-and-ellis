import { newId } from './state.js';

// Live (temporary) effects on entities. One representation for everything: buffs, debuffs,
// protections, marks and statuses all live in entity.effects[] and persist with the game state
// (so they survive reconnects, restarts and undo).
//
// Timing. Combat has a monotonically increasing phase counter (combat.phaseSeq, 1 = PLAYER PHASE
// of round 1). A timed effect stores `expires.atSeq`: it is removed when phaseSeq reaches that
// value. Duration names are normalized here:
//   current_turn / end_of_phase      -> until the current phase ends
//   until_next_player_phase          -> until the next PLAYER PHASE starts
//   next_dm_phase                    -> through the end of the next DM PHASE
//   { phases: N }                    -> for N phase transitions
//   combat                           -> until combat ends
//   until_used / null                -> no time limit (trigger effects; cleared only when used)
// Effects applied outside combat with a phase-based duration are "pending" and their clock starts
// when combat begins. Ending combat clears every timed effect.

export const DURATIONS = ['current_turn', 'end_of_phase', 'until_next_player_phase', 'next_dm_phase', 'combat', 'until_used'];
export const TRIGGERS = ['next_hit', 'next_magical_hit', 'next_attack_against_self', 'until_used', 'until_next_heal_by_caster', 'until_next_hit'];

export function isValidDuration(d) {
  if (d === undefined || d === null) return true;
  if (typeof d === 'string') return DURATIONS.includes(d);
  return typeof d === 'object' && Number.isInteger(d.phases) && d.phases >= 1 && d.phases <= 20;
}

function atSeqFor(duration, seq, phase) {
  if (duration === 'current_turn' || duration === 'end_of_phase') return seq + 1;
  if (duration === 'until_next_player_phase') return phase === 'player' ? seq + 2 : seq + 1;
  if (duration === 'next_dm_phase') return phase === 'player' ? seq + 2 : seq + 3;
  if (duration && typeof duration === 'object') return seq + duration.phases;
  return null;
}

export function computeExpiry(state, duration) {
  const timed = duration && duration !== 'until_used';
  if (!timed) return { atSeq: null, pending: null, onCombatEnd: false };
  if (duration === 'combat') return { atSeq: null, pending: null, onCombatEnd: true };
  const c = state.combat;
  if (!c.active) return { atSeq: null, pending: duration, onCombatEnd: true };
  return { atSeq: atSeqFor(duration, c.phaseSeq ?? 1, c.phase), pending: null, onCombatEnd: true };
}

// eff: { type, label, icon, source: { entityId, name }, params, trigger, duration, status }
export function addEffect(state, target, eff) {
  target.effects ??= [];
  const live = {
    id: newId('fx'),
    type: eff.type,
    label: eff.label ?? eff.type,
    icon: eff.icon ?? '✦',
    status: eff.status ?? null,
    source: eff.source ?? null,
    params: eff.params ?? {},
    trigger: eff.trigger ?? null,
    expires: computeExpiry(state, eff.duration),
  };
  target.effects.push(live);
  return live;
}

export const effectsOf = (e, type) => (e?.effects ?? []).filter((x) => x.type === type);
export const hasStatus = (e, status) => (e?.effects ?? []).some((x) => x.status === status);

export function removeEffect(e, id) {
  if (!e?.effects) return null;
  const i = e.effects.findIndex((x) => x.id === id);
  return i < 0 ? null : e.effects.splice(i, 1)[0];
}

// Removes every live effect carrying `status` from the entity; returns the removed effects.
export function clearStatus(e, status) {
  const gone = (e?.effects ?? []).filter((x) => x.status === status);
  for (const fx of gone) removeEffect(e, fx.id);
  return gone;
}

// Phase-counter bookkeeping for one transition. Returns [{ entity, effect }] that expired.
export function tickEffects(state, transition) {
  const expired = [];
  const c = state.combat;
  for (const e of Object.values(state.entities)) {
    if (!e.effects?.length) continue;
    e.effects = e.effects.filter((fx) => {
      const x = fx.expires ?? {};
      if (transition === 'start' && x.pending) {
        fx.expires = { atSeq: atSeqFor(x.pending, 1, 'player'), pending: null, onCombatEnd: true };
        return true;
      }
      let gone = false;
      if (transition === 'end') gone = !!x.onCombatEnd;
      else if (x.atSeq !== null && x.atSeq !== undefined) gone = c.phaseSeq >= x.atSeq;
      if (e.status === 'dead' && e.kind !== 'object') gone = true;
      if (gone) expired.push({ entity: e, effect: fx });
      return !gone;
    });
  }
  return expired;
}

// Movement this phase after modifiers (snared = 0).
export function movementAllowance(e) {
  if (hasStatus(e, 'snared')) return 0;
  const mod = effectsOf(e, 'modify_movement').reduce((s, fx) => s + (fx.params.amount ?? 0), 0);
  return Math.max(0, (e.movement ?? 0) + mod);
}
