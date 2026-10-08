import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDice, rollDice, isValidDice } from '../server/dice.js';

test('parses standard expressions', () => {
  assert.deepEqual(parseDice('1d20+5'), [{ sign: 1, count: 1, sides: 20 }, { sign: 1, value: 5 }]);
  assert.deepEqual(parseDice('d8'), [{ sign: 1, count: 1, sides: 8 }]);
  assert.deepEqual(parseDice('3d6 - 2'), [{ sign: 1, count: 3, sides: 6 }, { sign: -1, value: 2 }]);
  for (const e of ['1d4', '2d6', '3d6+2', '1d8+4', '1d10', '1d12', '1d8+1d6+2']) assert.ok(isValidDice(e), e);
});

test('rejects invalid expressions', () => {
  for (const e of ['', 'd', '1d7', '5', '1d20++5', 'abc', '1d20+x', '0d6', '999d6', '+', '1d20 5']) {
    assert.equal(isValidDice(e), false, e);
  }
});

test('rolls are within bounds', () => {
  for (let i = 0; i < 500; i++) {
    const r = rollDice('2d6+3');
    assert.ok(r.total >= 5 && r.total <= 15);
    const d = rollDice('1d20');
    assert.ok(d.natural >= 1 && d.natural <= 20);
  }
});

test('critical doubles dice but not modifier', () => {
  const r = rollDice('1d8+3', { rng: () => 8, critical: true });
  assert.equal(r.total, 19);
  assert.equal(r.rolls[0].results.length, 2);
  assert.equal(r.natural, null);
});

test('formats roll text', () => {
  assert.equal(rollDice('2d6+1', { rng: () => 3 }).text, '[3,3]+1 = 7');
});
