// Automatic role bonuses for player characters. This is the single source of truth: the damage
// and healing pipelines in combat.js read these multipliers, and the role-selection tiles show
// the blurbs (served through /api/content/public).
export const ROLE_RULES = {
  tank: { damageTakenMultiplier: 0.25, blurb: 'Takes ¼ damage' },
  dps: { damageDealtMultiplier: 4, blurb: 'Deals 4× damage' },
  heal: { healingDoneMultiplier: 4, blurb: 'Heals for 4×' },
};

// Role rules apply to player characters only (never monsters, NPCs or the DM's tools).
export const roleOf = (e) => (e?.kind === 'pc' ? ROLE_RULES[e.role] ?? null : null);

export const publicRoles = () => Object.fromEntries(Object.entries(ROLE_RULES).map(([id, r]) => [id, { blurb: r.blurb }]));
