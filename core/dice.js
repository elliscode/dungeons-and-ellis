import { randomInt } from 'node:crypto';

export const DICE_SIDES = [4, 6, 8, 10, 12, 20];
const MAX_DICE = 50;
const MAX_MODIFIER = 1000;

export class DiceError extends Error {}

const defaultRng = (sides) => randomInt(1, sides + 1);

// Parses expressions like "1d20+5", "2d6", "d8", "3d6+2", "1d8+1d6-1".
export function parseDice(expr) {
  if (typeof expr !== 'string') throw new DiceError('Dice expression must be a string');
  const src = expr.replace(/\s+/g, '').toLowerCase();
  if (!src || src.length > 40) throw new DiceError(`Invalid dice expression "${expr}"`);
  const terms = [];
  const re = /([+-]?)(?:(\d*)d(\d+)|(\d+))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || (pos > 0 && !m[1])) throw new DiceError(`Invalid dice expression "${expr}"`);
    const sign = m[1] === '-' ? -1 : 1;
    if (m[3] !== undefined) {
      const count = m[2] === '' ? 1 : Number(m[2]);
      const sides = Number(m[3]);
      if (!DICE_SIDES.includes(sides)) throw new DiceError(`Unsupported die d${sides}`);
      if (count < 1 || count > MAX_DICE) throw new DiceError(`Dice count must be 1-${MAX_DICE}`);
      terms.push({ sign, count, sides });
    } else {
      const value = Number(m[4]);
      if (value > MAX_MODIFIER) throw new DiceError('Modifier too large');
      terms.push({ sign, value });
    }
    pos = re.lastIndex;
  }
  if (!terms.some((t) => t.sides)) throw new DiceError(`"${expr}" has no dice`);
  return terms;
}

export function isValidDice(expr) {
  try { parseDice(expr); return true; } catch { return false; }
}

// critical: roll every die term twice (crit damage doubles the dice, not the modifier).
export function rollDice(expr, { rng = defaultRng, critical = false } = {}) {
  const terms = parseDice(expr);
  let total = 0;
  const rolls = [];
  for (const t of terms) {
    if (t.sides) {
      const count = critical ? t.count * 2 : t.count;
      const results = Array.from({ length: count }, () => rng(t.sides));
      rolls.push({ sides: t.sides, sign: t.sign, results });
      total += t.sign * results.reduce((a, b) => a + b, 0);
    } else {
      total += t.sign * t.value;
    }
  }
  const single = terms.filter((t) => t.sides);
  const natural = single.length === 1 && single[0].count === 1 && single[0].sides === 20 && !critical
    ? rolls[0].results[0] : null;
  return { expr: expr.replace(/\s+/g, ''), total, rolls, natural, text: formatRoll(terms, rolls, total) };
}

function formatRoll(terms, rolls, total) {
  const parts = [];
  let ri = 0;
  for (const t of terms) {
    const sign = t.sign < 0 ? '-' : parts.length ? '+' : '';
    if (t.sides) parts.push(`${sign}[${rolls[ri++].results.join(',')}]`);
    else parts.push(`${sign}${t.value}`);
  }
  return `${parts.join('')} = ${total}`;
}
