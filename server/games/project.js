import { entitiesInScene, isFriendly } from './state.js';

function publicPlayer(p, presence) {
  return {
    id: p.id, name: p.name, color: p.color, characterId: p.characterId, entityId: p.entityId,
    presence: presence(p.id),
  };
}

export function projectForDm(state, presence) {
  const { players, ...rest } = state;
  return {
    role: 'dm',
    ...structuredClone(rest),
    players: Object.values(players).map((p) => publicPlayer(p, presence)),
  };
}

function entityView(e, sceneId, viewerPlayerId) {
  const v = {
    id: e.id, kind: e.kind, defId: e.defId, name: e.name, role: e.role, image: e.image, size: e.size,
    status: e.status, hostile: e.hostile, z: e.z, ownerPlayerId: e.ownerPlayerId, scope: e.scope,
    position: e.positions[sceneId] ?? null,
  };
  if (isFriendly(e)) {
    v.hp = e.hp;
    v.maxHp = e.maxHp;
  }
  if (viewerPlayerId && e.ownerPlayerId === viewerPlayerId) {
    Object.assign(v, structuredClone({
      defense: e.defense, movement: e.movement, attacks: e.attacks, abilities: e.abilities, inventory: e.inventory,
    }));
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
    entities: scene ? entitiesInScene(state, sceneId).map((e) => entityView(e, sceneId, playerId)) : [],
  };
}

export function activityForRole(row, role) {
  const out = { id: row.id, ts: row.ts, type: row.type, text: row.text, color: row.color };
  if (role === 'dm' && row.dmText) out.text = row.dmText;
  return out;
}
