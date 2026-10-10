import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, scriptedRng, ok, DM, content } from './helpers.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { roleRules, setRoleStrength, getRoleStrength, DEFAULT_ROLE_STRENGTH } from '../server/games/roles.js';
import { loadSettings } from '../server/settings.js';

// d20 → 15, every other die → 1 unless queued.
const fallback = (sides) => (sides === 20 ? 15 : 1);

function world(heroes) {
  const rng = scriptedRng(fallback);
  const s = setup({ rng });
  const tpl = s.templates.create({ name: 'Arena', grid: { cols: 14, rows: 10 } });
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: tpl.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const h = {};
  for (const [key, charId, x, y] of heroes) {
    const p = s.join(key);
    ok(s.run(p, { type: 'player.selectCharacter', characterId: charId }));
    const id = s.state().players[p.playerId].entityId;
    ok(s.run(DM, { type: 'move', entityId: id, x, y, force: true }));
    h[key] = { actor: p, id };
  }
  const ent = (id) => s.state().entities[id];
  return {
    ...s, rng, h, ent,
    hero: (k) => ent(h[k].id),
    spawn: (defId, x, y, kind = 'monster') => ok(s.run(DM, { type: 'entity.spawn', kind, defId, x, y })).entityId,
    use: (k, abilityId, extra = {}) => s.run(h[k].actor, { type: 'ability', entityId: h[k].id, abilityId, ...extra }),
    attack: (k, attackId, targetId) => s.run(h[k].actor, { type: 'attack', entityId: h[k].id, attackId, targetId }),
    last: (role = 'player') => s.service.history(s.game.id, role).feed.at(-1).text,
  };
}

test('DPS weapon attacks and ability attacks deal 4× (each strike once)', () => {
  const w = world([['rogue', 'x-shadow-rogue', 0, 0], ['monk', 'x-wind-monk', 0, 2]]);
  const dummy = w.spawn('training-dummy', 1, 1);
  ok(w.run(DM, { type: 'combat.start' }));
  w.rng.push(15, 2, 2); // twin daggers: 2d4+4 = 8 → ×4 DPS = 32
  const r = ok(w.attack('rogue', 'twin-daggers', dummy));
  assert.equal(r.damage, 32);
  assert.match(w.last(), /HIT for 32 \(\[2,2\]\+4 = 8, ×4 DPS\)/);
  ok(w.use('monk', 'flurry-of-blows', { targetId: dummy })); // 4 hits of (1+1+2) = 4 → 16 each
  assert.equal(w.ent(dummy).damageTaken, 32 + 4 * 16);
});

test('DPS crit: dice doubled first, then ×4; area and chain multiply per target', () => {
  const w = world([['storm', 'x-stormcaller', 5, 5]]);
  const d1 = w.spawn('training-dummy', 6, 5), d2 = w.spawn('training-dummy', 7, 6);
  ok(w.run(DM, { type: 'combat.start' }));
  w.rng.push(20, 1, 1, 1, 1); // crit: 2d8 → 4d8 = 4, +1 = 5 → 20 ; second target fallback hit 2+1 = 3 → 12
  ok(w.use('storm', 'chain-lightning', { targetId: d1, picks: [d2] }));
  ok(w.run(DM, { type: 'entity.grantAction', entityId: w.h.storm.id }));
  assert.equal(w.ent(d1).damageTaken, 20);
  assert.equal(w.ent(d2).damageTaken, 12);
  ok(w.use('storm', 'thunderclap')); // radius 2: both dummies, 1d8+3 = 4 → 16 each
  assert.equal(w.ent(d1).damageTaken, 36);
  assert.equal(w.ent(d2).damageTaken, 28);
});

test('DPS hitting a tank: ×4 then the tank takes ¼ (exactly once each)', () => {
  const w = world([['mage', 'x-fire-mage', 0, 0], ['wall', 'x-shieldmarshal', 2, 0]]);
  // Friendly fire through a weapon attack (players may target allies with weapons).
  ok(w.run(DM, { type: 'combat.start' }));
  w.rng.push(15, 5); // fire bolt 1d10+3 = 8 → ×4 = 32 → tank ¼ = 8
  const r = ok(w.attack('mage', 'fire-bolt', w.h.wall.id));
  assert.equal(r.damage, 8);
  assert.equal(w.hero('wall').hp, 44 - 8);
  assert.match(w.last(), /×4 DPS, reduced by Tank/);
});

test('protections and debuffs still apply after the DPS multiplier', () => {
  const w = world([['wall', 'x-shieldmarshal', 0, 0], ['mage', 'x-fire-mage', 3, 0], ['lock', 'x-void-warlock', 6, 0]]);
  ok(w.use('wall', 'shield-wall'));
  ok(w.run(DM, { type: 'combat.start' }));
  w.rng.push(15, 5); // 8 → 32 → halved 16 → tank 4
  assert.equal(ok(w.attack('mage', 'fire-bolt', w.h.wall.id)).damage, 4);
  // Curse of Weakness on a DPS hero: halve first (attacker modifier), then ×4.
  const curse = { type: 'modify_damage_dealt', label: 'Curse', trigger: 'next_hit', params: { multiplier: 0.5 } };
  const lock = w.hero('lock');
  lock.effects.push({ id: 'fx_test', icon: '🥀', status: null, source: null, expires: { atSeq: null }, ...curse });
  const dummy = w.spawn('training-dummy', 7, 0);
  w.rng.push(15, 7); // life drain 1d8+3 = 10 → curse 5 → ×4 = 20
  ok(w.use('lock', 'life-drain', { targetId: dummy }));
  assert.equal(w.ent(dummy).damageTaken, 20);
});

test('Heal-role healing is 4× (capped), Beacon adds after, downed allies recover', () => {
  const w = world([['cleric', 'x-cleric', 0, 0], ['ranger', 'x-ranger', 1, 0], ['lp', 'x-light-paladin', 2, 0]]);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ranger.id, amount: 30 }));
  w.rng.push(2); // 1d8+3 = 5 → ×4 = 20
  ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }));
  assert.equal(w.hero('ranger').hp, 4 + 20);
  assert.match(w.last(), /\+20 \(\[2\]\+3 = 5\) \(×4 Heal\)/);
  ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }));
  assert.equal(w.hero('ranger').hp, 34, 'never above max HP');
  ok(w.run(DM, { type: 'entity.setHp', entityId: w.h.ranger.id, hp: 0 }));
  assert.equal(w.hero('ranger').status, 'down');
  ok(w.use('lp', 'beacon-of-grace', { targetId: w.h.ranger.id }));
  ok(w.use('lp', 'flash-of-light', { targetId: w.h.ranger.id })); // 1d8+4 = 5 → 20, +3 Beacon = 23
  assert.equal(w.hero('ranger').hp, 23);
  assert.equal(w.hero('ranger').status, 'active');
});

test('other roles and DM-controlled entities get no multiplier', () => {
  const w = world([['wall', 'x-shieldmarshal', 0, 0], ['cleric', 'x-cleric', 0, 2], ['lock', 'x-void-warlock', 0, 4]]);
  const dummy = w.spawn('training-dummy', 1, 1);
  ok(w.run(DM, { type: 'combat.start' }));
  w.rng.push(15, 1);
  ok(w.attack('wall', w.hero('wall').attacks[0].id, dummy)); // tank: 1×
  const tankHit = w.ent(dummy).damageTaken;
  assert.ok(tankHit > 0 && tankHit < 20);
  w.rng.push(15, 1);
  ok(w.attack('cleric', 'mace', dummy)); // healer weapon: 1d6+3 = 4, 1×
  assert.equal(w.ent(dummy).damageTaken, tankHit + 4);
  // DPS self-heal (Life Drain) is not a Heal-role heal.
  ok(w.run(DM, { type: 'entity.damage', entityId: w.h.lock.id, amount: 20 }));
  w.rng.push(15, 1, 6); // hit, then heal 1d6+2 = 8 (1×)
  ok(w.use('lock', 'life-drain', { targetId: dummy }));
  assert.equal(w.hero('lock').hp, 30 - 20 + 8);
  // Monster and NPC attacks, and the DM's tools, are 1×.
  ok(w.run(DM, { type: 'combat.advance' }));
  const gob = w.spawn('goblin', 1, 3);
  w.rng.push(15, 3); // scimitar 1d6+2 = 5 vs the warlock (DPS): no bonus for monsters, none for being DPS
  assert.equal(ok(w.run(DM, { type: 'attack', entityId: gob, attackId: 'scimitar', targetId: w.h.lock.id })).damage, 5);
  const before = w.ent(dummy).damageTaken;
  ok(w.run(DM, { type: 'entity.damage', entityId: dummy, amount: 7 }));
  assert.equal(w.ent(dummy).damageTaken, before + 7);
  ok(w.run(DM, { type: 'entity.heal', entityId: w.h.lock.id, amount: 3 }));
  assert.equal(w.hero('lock').hp, 18 - 5 + 3);
});

test('role tiles are driven by the same rules', () => {
  const roles = content.publicContent().roles;
  assert.deepEqual(Object.keys(roles).sort(), ['dps', 'heal', 'tank']);
  for (const [id, r] of Object.entries(roleRules())) assert.equal(roles[id].blurb, r.blurb);
  assert.equal(roles.tank.blurb, 'Takes ¼ damage');
  assert.equal(roles.dps.blurb, 'Deals 4× damage');
  assert.equal(roles.heal.blurb, 'Heals for 4×');
});

test('damage abilities are combat-only; heals, buffs and debuffs are not', async () => {
  const w = world([['mage', 'x-fire-mage', 0, 0], ['cleric', 'x-cleric', 1, 0], ['ranger', 'x-ranger', 2, 0], ['wall', 'x-shieldmarshal', 3, 0]]);
  const gob = w.spawn('goblin', 5, 0);
  assert.match(w.use('mage', 'inferno-surge', { targetId: gob }).error, /deals damage and is only available in combat/);
  assert.match(w.attack('mage', 'fire-bolt', gob).error, /only available in combat/);
  ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }), 'heals work while exploring');
  ok(w.use('wall', 'shield-wall'), 'buffs work while exploring');
  ok(w.use('ranger', 'hunters-mark', { targetId: gob }), 'non-damaging debuffs work while exploring');
  ok(w.use('mage', 'light'), 'narrative abilities work while exploring');
  const { projectForPlayer } = await import('../server/games/project.js');
  const mine = projectForPlayer(w.state(), w.h.mage.actor.playerId, () => 'online').entities.find((e) => e.id === w.h.mage.id);
  assert.deepEqual(Object.fromEntries(mine.abilities.map((a) => [a.id, a.combatOnly])), { 'inferno-surge': true, light: false });
  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.use('mage', 'inferno-surge', { targetId: gob }), 'allowed once combat starts');
});

// ---------- configurable role strength (global setting, presets 1–5) ----------

// Runs fn with a given role strength and always restores the default afterwards.
function withStrength(n, fn) {
  setRoleStrength(n);
  try { return fn(); } finally { setRoleStrength(DEFAULT_ROLE_STRENGTH); }
}

test('every preset 1–5 changes DPS damage, healing and tank mitigation everywhere', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    withStrength(n, () => {
      const w = world([['rogue', 'x-shadow-rogue', 0, 0], ['cleric', 'x-cleric', 1, 0], ['wall', 'x-shieldmarshal', 2, 0], ['ranger', 'x-ranger', 3, 0]]);
      const dummy = w.spawn('training-dummy', 0, 1);
      ok(w.run(DM, { type: 'combat.start' }));
      w.rng.push(15, 2, 2); // twin daggers 2d4+4 = 8
      assert.equal(ok(w.attack('rogue', 'twin-daggers', dummy)).damage, 8 * n, `DPS ×${n}`);
      ok(w.run(DM, { type: 'entity.damage', entityId: w.h.wall.id, amount: 30 }));
      assert.equal(w.hero('wall').hp, 44 - Math.max(1, Math.floor(30 / n)), `tank takes 1/${n}`);
      ok(w.run(DM, { type: 'entity.damage', entityId: w.h.ranger.id, amount: 30 }));
      w.rng.push(1); // healing word 1d8+3 = 4
      ok(w.use('cleric', 'healing-word', { targetId: w.h.ranger.id }));
      assert.equal(w.hero('ranger').hp, Math.min(34, 4 + 4 * n), `heal ×${n}`);
      if (n === 1) assert.doesNotMatch(w.last(), /×1/, 'no "×1" notes when bonuses are off');
    });
  }
});

test('tank minimum of 1 and exact integer division at every strength', () => {
  for (const n of [2, 3, 4, 5]) {
    withStrength(n, () => {
      const w = world([['wall', 'x-shieldmarshal', 0, 0]]);
      for (const raw of [1, 2, 3, 9, 10, 15, 30]) {
        const before = w.hero('wall').hp;
        ok(w.run(DM, { type: 'entity.damage', entityId: w.h.wall.id, amount: raw }));
        assert.equal(before - w.hero('wall').hp, Math.max(1, Math.floor(raw / n)), `raw ${raw} at 1/${n}`);
        ok(w.run(DM, { type: 'entity.setHp', entityId: w.h.wall.id, hp: 44 }));
      }
    });
  }
});

test('role tile blurbs follow the setting', () => {
  const expected = {
    1: ['Takes full damage', 'Deals normal damage', 'Heals normally'],
    2: ['Takes ½ damage', 'Deals 2× damage', 'Heals for 2×'],
    3: ['Takes ⅓ damage', 'Deals 3× damage', 'Heals for 3×'],
    4: ['Takes ¼ damage', 'Deals 4× damage', 'Heals for 4×'],
    5: ['Takes ⅕ damage', 'Deals 5× damage', 'Heals for 5×'],
  };
  for (const [n, [tank, dps, heal]] of Object.entries(expected)) {
    withStrength(Number(n), () => {
      const roles = content.publicContent().roles;
      assert.deepEqual([roles.tank.blurb, roles.dps.blurb, roles.heal.blurb], [tank, dps, heal]);
    });
  }
});

test('settings file: defaults to 4, only accepts 1–5, persists, survives a bad file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dne-settings-'));
  try {
    const s1 = loadSettings(dir);
    assert.equal(s1.get().roleStrength, 4, 'missing file → default 4');
    for (const bad of [0, 6, 2.5, -1, 'abc', '', null, '10']) assert.throws(() => s1.setRoleStrength(bad), /one of 1, 2, 3, 4, 5/, String(bad));
    let changed = null;
    s1.on('change', (c) => { changed = c; });
    s1.setRoleStrength('3');
    assert.deepEqual(changed, { before: 4, after: 3 });
    assert.equal(getRoleStrength(), 3, 'applied to the live rules');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), { roleStrength: 3 });
    const s2 = loadSettings(dir);
    assert.equal(s2.get().roleStrength, 3, 'reloaded from disk');
    writeFileSync(join(dir, 'settings.json'), '{"roleStrength": 9}');
    assert.equal(loadSettings(dir).get().roleStrength, 4, 'invalid value → default');
    writeFileSync(join(dir, 'settings.json'), '{ nope');
    assert.equal(loadSettings(dir).get().roleStrength, 4, 'broken JSON → default');
  } finally {
    setRoleStrength(DEFAULT_ROLE_STRENGTH);
    rmSync(dir, { recursive: true, force: true });
  }
});
