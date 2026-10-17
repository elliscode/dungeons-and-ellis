import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, ok, DM, content } from './helpers.js';
import { validateDefs } from '../core/content.js';
import { stripMarkers } from '../core/helpers.js';

// Rogue (dps, 32 HP) at (0,0) and Cleric (heal, 34 HP) at (1,0): adjacent. Both carry a Healing Potion.
function party() {
  const s = setup();
  const sid = ok(s.run(DM, { type: 'scene.add', templateId: s.tpl2.id })).sceneId;
  ok(s.run(DM, { type: 'scene.activate', sceneId: sid }));
  const hero = (name, characterId, x, y) => {
    const actor = s.join(name);
    ok(s.run(actor, { type: 'player.selectCharacter', characterId }));
    const id = s.state().players[actor.playerId].entityId;
    ok(s.run(DM, { type: 'move', entityId: id, x, y, force: true }));
    return { actor, id };
  };
  const rog = hero('Ana', 'shadow-rogue', 0, 0);
  const cle = hero('Bo', 'cleric', 1, 0);
  const ent = (id) => s.state().entities[id];
  const potion = (h) => ent(h.id).inventory.find((i) => i.name === 'Healing Potion');
  const drink = (h, targetId, item = potion(h)) => s.run(h.actor, { type: 'item.use', entityId: h.id, itemId: item.id, ...(targetId ? { targetId } : {}) });
  const last = () => stripMarkers(s.service.history(s.game.id, 'dm').feed.at(-1).text);
  return { ...s, rog, cle, ent, potion, drink, last };
}

test('Healing Potion: inventory entries link to the catalog by id', () => {
  const w = party();
  assert.equal(w.potion(w.rog).defId, 'healing-potion');
  assert.equal(content.item(w.potion(w.rog)).ability.range, 1);
});

test('Healing Potion heals yourself for exactly 25 and is used up', () => {
  const w = party();
  ok(w.run(DM, { type: 'entity.damage', entityId: w.rog.id, amount: 30 }));
  ok(w.drink(w.rog, w.rog.id));
  assert.equal(w.ent(w.rog.id).hp, 2 + 25);
  assert.equal(w.potion(w.rog), undefined);
  assert.match(w.last(), /Shadow Rogue uses Healing Potion: Shadow Rogue \+25 \(25\)/);
});

test('Healing Potion skips the Heal role bonus', () => {
  const w = party();
  ok(w.run(DM, { type: 'entity.damage', entityId: w.cle.id, amount: 30 }));
  ok(w.drink(w.cle, w.cle.id));
  assert.equal(w.ent(w.cle.id).hp, 4 + 25, 'flat 25, not 25 × the role multiplier');
});

test('Healing Potion can be given to an adjacent ally, including a downed one', () => {
  const w = party();
  ok(w.run(DM, { type: 'entity.damage', entityId: w.cle.id, amount: 50 }));
  assert.deepEqual([w.ent(w.cle.id).status, w.ent(w.cle.id).hp], ['down', -16]);
  ok(w.drink(w.rog, w.cle.id));
  assert.deepEqual([w.ent(w.cle.id).status, w.ent(w.cle.id).hp], ['active', 25], 'negative HP resets to 0, then +25');
  assert.match(w.last(), /Shadow Rogue uses Healing Potion on Cleric/);
});

test('Healing Potion is kept when the ability fails', () => {
  const w = party();
  ok(w.run(DM, { type: 'move', entityId: w.cle.id, x: 3, y: 0, force: true }));
  assert.match(w.drink(w.rog, w.cle.id).error, /out of range \(1\)/);
  assert.ok(w.potion(w.rog), 'out of range: still in the inventory');
  const gob = ok(w.run(DM, { type: 'entity.spawn', kind: 'monster', defId: 'goblin', x: 0, y: 1 })).entityId;
  assert.match(w.drink(w.rog, gob).error, /not an ally/);
  assert.ok(w.potion(w.rog), 'enemy target: still in the inventory');

  ok(w.run(DM, { type: 'combat.start' }));
  ok(w.run(w.rog.actor, { type: 'item.use', entityId: w.rog.id, itemId: w.ent(w.rog.id).inventory[0].id })); // Thieves' Tools
  assert.match(w.drink(w.rog, w.rog.id).error, /action/);
  assert.ok(w.potion(w.rog), 'no actions left: still in the inventory');
});

test('items without an ability are still used up in one click', () => {
  const w = party();
  const tools = w.ent(w.rog.id).inventory[0];
  assert.equal(tools.name, 'Thieves Tools');
  ok(w.run(w.rog.actor, { type: 'item.use', entityId: w.rog.id, itemId: tools.id }));
  assert.equal(w.ent(w.rog.id).inventory.some((i) => i.id === tools.id), false);
  assert.match(w.last(), /Shadow Rogue uses Thieves Tools/);
});

test('a DM-added "Healing Potion" (no catalog id) gets the ability by name', () => {
  const w = party();
  for (const it of [...w.ent(w.rog.id).inventory]) ok(w.run(DM, { type: 'item.remove', entityId: w.rog.id, itemId: it.id }));
  ok(w.run(DM, { type: 'item.add', entityId: w.rog.id, name: 'healing potion' }));
  const added = w.ent(w.rog.id).inventory[0];
  assert.equal(added.defId, undefined);
  ok(w.run(DM, { type: 'entity.damage', entityId: w.rog.id, amount: 30 }));
  ok(w.drink(w.rog, w.rog.id, added));
  assert.equal(w.ent(w.rog.id).hp, 27);
  assert.equal(w.ent(w.rog.id).inventory.length, 0);
});

test('item catalog validation', () => {
  const check = (defs) => validateDefs('items', [{ file: 'items.json', defs }]).errors;
  assert.deepEqual(check([{ id: 'rope', name: 'Rope' }]), []);
  assert.deepEqual(check([{ id: 'p', name: 'P', ability: { range: 1, effects: [{ type: 'heal', target: 'ally_or_self', heal: 25 }] } }]), []);
  assert.match(check([{ id: 'p', name: 'P', ability: { effects: [{ type: 'heal', heal: 0 }] } }]).join('\n'), /heal must be dice .* or a whole number/);
  assert.match(check([{ id: 'p', name: 'P', ability: { effects: [{ type: 'explode' }] } }]).join('\n'), /unknown effect type/);
  assert.match(check([{ id: 'p', name: 'P', ability: [] }]).join('\n'), /ability must be an object/);
});
