// Client side of the ability engine: summaries for menus and the targeting flow. The server
// sends each ability's `targeting` ({ kind: enemy|ally|cell|none, range, includeSelf, chain });
// the client only collects the picks and the server validates and resolves everything.

export const sideOf = (e) => (!e || e.kind === 'object' ? null : e.kind === 'pc' || (e.kind === 'npc' && !e.hostile) ? 'party' : 'foe');

export const footprintDistance = (a, sa, b, sb) => {
  const dx = Math.max(0, b.x - (a.x + sa.w - 1), a.x - (b.x + sb.w - 1));
  const dy = Math.max(0, b.y - (a.y + sa.h - 1), a.y - (b.y + sb.h - 1));
  return Math.max(dx, dy);
};
export const distance = (a, b) => (a?.position && b?.position ? footprintDistance(a.position, a.size, b.position, b.size) : Infinity);

const EFFECT_WORDS = {
  attack: (e) => `${e.attack} / ${e.damage}`,
  multi_attack: (e) => `${e.count}× ${e.attack} / ${e.damage}`,
  area_attack: (e) => `area r${e.radius ?? 1}: ${e.attack} / ${e.damage}`,
  chain_attack: (e) => `chain +${e.jumps}: ${e.attack} / ${e.damage}`,
  heal: (e) => `heal ${e.heal}`,
  chain_heal: (e) => `chain heal +${e.jumps}: ${e.heal}`,
  teleport: (e) => `teleport ${e.distance}`,
  grant_actions: (e) => `+${e.amount} action`,
  absorb_next_hit: () => 'absorb next hit',
  grant_protection: () => 'halve next hit',
  redirect_next_hit: () => 'take the next hit for an ally',
  defense_bonus: (e) => `${e.amount >= 0 ? '+' : ''}${e.amount} DEF`,
  roll_to_apply: (e) => `roll ${e.roll} vs DEF`,
  dm_check: (e) => `roll ${e.roll}, DM decides`,
  healing_aura: () => 'healing totem',
  create_barrier: () => 'barrier',
};

export function abilitySummary(ab) {
  const bits = [];
  for (const e of ab.effects ?? []) {
    const w = EFFECT_WORDS[e.type]?.(e);
    if (w && !bits.includes(w)) bits.push(w);
  }
  const t = ab.targeting ?? { kind: 'none' };
  if (t.kind !== 'none') bits.push(`range ${t.range}`);
  if (ab.actionCost === 0) bits.push('free');
  if (ab.usesPerPhase) bits.push(ab.usesPerPhase === 1 ? 'once/phase' : `${ab.usesPerPhase}/phase`);
  return bits.join(' · ');
}

// Builds the board mode(s) to activate `ab` as `caster`. Calls send(extra) with the picks.
// setMode(mode) shows a mode; modes are { type: 'target'|'cell', label, range, origin, filter,
// onTarget/onCell, onDone? }.
export function startAbility({ caster, ab, entities, setMode, send, toast }) {
  const t = ab.targeting ?? { kind: 'none' };
  const base = { type: 'ability', entityId: caster.id, abilityId: ab.id };
  if (t.kind === 'none') return send(base);
  if (t.kind === 'cell') {
    return setMode({
      type: 'cell', label: `${ab.name}: pick a square (range ${t.range})`, range: t.range, origin: caster,
      onCell: (cell) => send({ ...base, cell }),
    });
  }
  const mySide = sideOf(caster);
  const wantAlly = t.kind === 'ally';
  const valid = (e) => e.status !== 'dead' && sideOf(e) && (wantAlly ? sideOf(e) === mySide && (e.id !== caster.id || t.includeSelf) : sideOf(e) !== mySide);
  setMode({
    type: 'target', label: `${ab.name}: choose ${wantAlly ? (t.includeSelf ? 'an ally or yourself' : 'an ally') : 'an enemy'}`,
    range: t.range, origin: caster, filter: valid,
    onTarget: (target) => {
      if (!t.chain) return send({ ...base, targetId: target.id });
      // Chains: the player picks each jump (never chosen silently), each within jumpRange of the last.
      const picks = [];
      const next = (from) => {
        if (picks.length >= t.chain.jumps) return send({ ...base, targetId: target.id, picks });
        const chainValid = (e) => valid(e) && e.id !== target.id && !picks.includes(e.id)
          && (!wantAlly || (e.hp !== undefined && e.hp < e.maxHp));
        if (!entities().some((e) => chainValid(e) && distance(from, e) <= t.chain.jumpRange)) return send({ ...base, targetId: target.id, picks });
        setMode({
          type: 'target', label: `${ab.name}: pick the next ${wantAlly ? 'wounded ally' : 'enemy'} (${picks.length + 1}/${t.chain.jumps}) or finish`,
          range: t.chain.jumpRange, origin: from, filter: chainValid,
          onTarget: (e2) => { picks.push(e2.id); next(e2); },
          onDone: () => send({ ...base, targetId: target.id, picks }),
        });
      };
      next(target);
    },
  });
  toast?.(`${ab.name}: click a target on the map`);
}
