// Automatic role bonuses for player characters, driven by one "role strength" n (1–5):
// tanks take 1/n damage, DPS deal n× damage, healers heal for n×. n = 1 turns bonuses off.
// This module is the single source of truth: the damage/heal pipeline in combat.js reads these
// rules, and the role-selection tiles show the blurbs (served through /api/content/public).
// The value is a per-server (or per-account) setting that the shell passes in: commands read it
// from ctx.settings.roleStrength (see roleStrengthOf); this module holds no state of its own.

export const ROLE_STRENGTHS = [1, 2, 3, 4, 5];
export const DEFAULT_ROLE_STRENGTH = 4;

export const isValidRoleStrength = (n) => ROLE_STRENGTHS.includes(n);

// The role strength for a command. Every shell must supply ctx.settings.roleStrength; a missing or
// invalid value is a wiring bug, so it throws instead of silently using a default.
export function roleStrengthOf(ctx) {
  const n = ctx?.settings?.roleStrength;
  if (!isValidRoleStrength(n)) throw new Error(`ctx.settings.roleStrength must be one of ${ROLE_STRENGTHS.join(', ')} (got ${n})`);
  return n;
}

const FRACTIONS = { 2: '½', 3: '⅓', 4: '¼', 5: '⅕' };

// The rules for a given strength.
export function roleRules(n) {
  return {
    tank: { damageTakenDivisor: n, blurb: n === 1 ? 'Takes full damage' : `Takes ${FRACTIONS[n]} damage` },
    dps: { damageDealtMultiplier: n, blurb: n === 1 ? 'Deals normal damage' : `Deals ${n}× damage` },
    heal: { healingDoneMultiplier: n, blurb: n === 1 ? 'Heals normally' : `Heals for ${n}×` },
  };
}

// Role rules apply to player characters only (never monsters, NPCs or the DM's tools).
export const roleOf = (e, n) => (e?.kind === 'pc' ? roleRules(n)[e.role] ?? null : null);

export const publicRoles = (n) => Object.fromEntries(Object.entries(roleRules(n)).map(([id, r]) => [id, { blurb: r.blurb }]));

// One-line summary, e.g. "Tank ⅓ · DPS 3× · Heal 3×".
export const describeStrength = (n) => (n === 1 ? 'No role bonuses' : `Tank ${FRACTIONS[n]} · DPS ${n}× · Heal ${n}×`);
