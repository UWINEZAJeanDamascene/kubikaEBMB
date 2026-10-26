const EXACT_DECIMAL_FIELDS = new Set(['invcFcurAmt', 'invcFcurExcrt']);
const NUMBER_MARKER = '__ebmJsonNumberLiteral__';

/** Parse VSDC JSON without rounding import invoice currency amount/rate literals. */
function preserveImportDecimalPrecision(raw) {
  if (typeof raw !== 'string') return raw;
  let marked = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (inString) {
      marked += char;
      index += 1;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      marked += char;
      index += 1;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(index));
      if (match) {
        marked += `{${JSON.stringify(NUMBER_MARKER)}:${JSON.stringify(match[0])}}`;
        index += match[0].length;
        continue;
      }
    }
    marked += char;
    index += 1;
  }

  let parsed;
  try {
    parsed = JSON.parse(marked);
  } catch {
    return { __ebmInvalidJsonResponse: true };
  }

  function restore(value, parentField = null) {
    if (Array.isArray(value)) return value.map((item) => restore(item));
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === NUMBER_MARKER) {
      const literal = value[NUMBER_MARKER];
      return EXACT_DECIMAL_FIELDS.has(parentField) ? literal : Number(literal);
    }
    return Object.fromEntries(keys.map((key) => [key, restore(value[key], key)]));
  }

  return restore(parsed);
}

module.exports = { preserveImportDecimalPrecision };
