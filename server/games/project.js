import { entitiesInScene, actionAllowance } from './state.js';
import { movementAllowance } from './status.js';
import { normalizeAbility, targetingOf, dealsDamage } from './effects.js';

// Abilities as the client needs them: canonical schema plus the server-computed targeting.
const abilitiesView = (list) => (list ?? []).map((a) => ({ ...normalizeAbility(a), targeting: targetingOf(a), combatOnly: dealsDamage(a) }));

// Labels and icons of live effects; magnitudes stay on the server.
const effectsView = (e) => (e.effects ?? []).map((fx) => ({ id: fx.id, icon: fx.icon, label: fx.label, status: fx.status, source: fx.source?.name ?? null }));

function allowances(state, e) {
  const t = state.turn[e.id];
  return { actions: actionAllowance(e, t), movement: movementAllowance(e) };
}

function publicPlayer(p, presence) {
  return {
    id: p.id, name: p.name, color: p.color, characterId: p.characterId, entityId: p.entityId,
    presence: presence(p.id),
  };
}

export function projectForDm(state, presence) {
  const { players, ...rest } = state;
  const view = structuredClone(rest);
  for (const e of Object.values(view.entities)) {
    e.abilities = abilitiesView(e.abilities);
    e.allowance = allowances(state, state.entities[e.id]);
  }
  view.pendingChecks ??= [];
  return {
    role: 'dm',
    ...view,
    players: Object.values(players).map((p) => publicPlayer(p, presence)),
  };
}

function entityView(e, sceneId, viewerPlayerId, state) {
  const v = {
    id: e.id, kind: e.kind, defId: e.defId, name: e.name, role: e.role, image: e.image, size: e.size,
    status: e.status, hostile: e.hostile, z: e.z, ownerPlayerId: e.ownerPlayerId, scope: e.scope,
    position: e.positions[sceneId] ?? null,
    effects: effectsView(e),
  };
  if (e.immortal) Object.assign(v, { immortal: true, damageTaken: e.damageTaken ?? 0, hits: e.hits ?? 0 });
  if (e.kind === 'object') Object.assign(v, { temporary: !!e.temporary, icon: e.icon ?? null });
  // Players only ever see PC HP: an NPC can turn hostile mid-scene, so its HP is never revealed.
  if (e.kind === 'pc') {
    v.hp = e.hp;
    v.maxHp = e.maxHp;
  }
  if (viewerPlayerId && e.ownerPlayerId === viewerPlayerId) {
    Object.assign(v, structuredClone({
      defense: e.defense, movement: e.movement, actionsPerPhase: e.actionsPerPhase ?? 1, attacks: e.attacks, inventory: e.inventory,
    }), { abilities: abilitiesView(e.abilities), allowance: allowances(state, e) });
  }
  return v;
}

// Player view: only the active scene, and no HP/stats for hostile creatures.
export function projectForPlayer(state, playerId, presence) {
  const me = state.players[playerId];
  const sceneId = state.activeSceneId;
  const scene = sceneId ? state.scenes[sceneId] : null;
  const taken = {};
  for (const p of Object.values(state.players)) if (p.characterId) taken[p.characterId] = p.id;
  return {
    role: 'player',
    game: { id: state.id, name: state.name },
    me: me ? publicPlayer(me, presence) : null,
    players: Object.values(state.players).map((p) => publicPlayer(p, presence)),
    takenCharacters: taken,
    combat: structuredClone(state.combat),
    turn: me?.entityId ? structuredClone(state.turn[me.entityId] ?? null) : null,
    scene: scene ? structuredClone(scene) : null,
    entities: scene ? entitiesInScene(state, sceneId).map((e) => entityView(e, sceneId, playerId, state)) : [],
  };
}

// What one viewer sees of a Game Feed row: DM-only rows are dropped for players, the DM gets the
// DM text (which may include hidden HP), and nothing private is otherwise attached.
export function feedForRole(row, role) {
  if (row.visibility === 'dm' && role !== 'dm') return null;
  const text = role === 'dm' && row.dmText ? row.dmText : row.text;
  if (!text) return null;
  const out = { id: row.id, ts: row.ts, kind: row.kind, type: row.type, text, color: row.color };
  if (row.kind === 'chat') Object.assign(out, { name: row.name, playerId: row.playerId });
  if (row.data) out.data = row.data;
  if (row.visibility === 'dm') out.dmOnly = true;
  return out;
}
