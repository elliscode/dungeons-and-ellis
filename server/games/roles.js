// Automatic role bonuses for player characters, driven by one global "role strength" n (1–5):
// tanks take 1/n damage, DPS deal n× damage, healers heal for n×. n = 1 turns bonuses off.
// This module is the single source of truth: the damage/heal pipeline in combat.js reads these
// rules, and the role-selection tiles show the blurbs (served through /api/content/public).
// The value is a server setting (data/settings.json, changed from the DM home page).

export const ROLE_STRENGTHS = [1, 2, 3, 4, 5];
export const DEFAULT_ROLE_STRENGTH = 4;

let strength = DEFAULT_ROLE_STRENGTH;

export const isValidRoleStrength = (n) => ROLE_STRENGTHS.includes(n);
export const getRoleStrength = () => strength;
export function setRoleStrength(n) {
  if (!isValidRoleStrength(n)) throw new Error(`Role strength must be one of ${ROLE_STRENGTHS.join(', ')}`);
  strength = n;
}

const FRACTIONS = { 2: '½', 3: '⅓', 4: '¼', 5: '⅕' };

// The rules for a given strength (defaults to the current setting).
export function roleRules(n = strength) {
  return {
    tank: { damageTakenDivisor: n, blurb: n === 1 ? 'Takes full damage' : `Takes ${FRACTIONS[n]} damage` },
    dps: { damageDealtMultiplier: n, blurb: n === 1 ? 'Deals normal damage' : `Deals ${n}× damage` },
    heal: { healingDoneMultiplier: n, blurb: n === 1 ? 'Heals normally' : `Heals for ${n}×` },
  };
}

// Role rules apply to player characters only (never monsters, NPCs or the DM's tools).
export const roleOf = (e) => (e?.kind === 'pc' ? roleRules()[e.role] ?? null : null);

export const publicRoles = () => Object.fromEntries(Object.entries(roleRules()).map(([id, r]) => [id, { blurb: r.blurb }]));

// One-line summary, e.g. "Tank ⅓ · DPS 3× · Heal 3×".
export const describeStrength = (n = strength) => (n === 1 ? 'No role bonuses' : `Tank ${FRACTIONS[n]} · DPS ${n}× · Heal ${n}×`);
