// Python-compatible compact JSON serialization.
//
// The data the page inlines was historically produced by Python's
// json.dumps(..., separators=(",", ":")) with the default ensure_ascii=True.
// To keep the built index.html byte-identical we must reproduce two Python-isms
// that JSON.stringify does NOT do:
//   1. Floats keep a trailing ".0" when integral (json.dumps(50.0) -> "50.0",
//      whereas JSON.stringify(50) -> "50"). Wrap such values in F()/PyFloat.
//   2. Non-ASCII characters are escaped as \uXXXX (ensure_ascii), e.g. the ♀/♂
//      in "Nidoran\u2640"/"Nidoran\u2642".

export class PyFloat {
  constructor(v) { this.v = v; }
}

/** Mark a number so it serializes like a Python float (integral -> "N.0"). */
export const F = (v) => new PyFloat(v);

function pyFloatStr(n) {
  if (!Number.isFinite(n)) throw new Error(`non-finite float: ${n}`);
  if (Number.isInteger(n)) return (Object.is(n, -0) ? '-0' : String(n)) + '.0';
  return String(n);
}

/** JSON string with Python ensure_ascii escaping (lowercase \uXXXX). */
export function pyStr(s) {
  return JSON.stringify(s).replace(
    /[\u0080-\uffff]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/**
 * Serialize like json.dumps(value, separators=(",", ":")).
 * @param {*} val
 * @param {boolean} forceFloat - treat every plain number as a Python float
 *   (used for the emblem stats subtree, where every number is a float).
 */
export function pyStringify(val, forceFloat = false) {
  if (val instanceof PyFloat) return pyFloatStr(val.v);
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'number') return forceFloat ? pyFloatStr(val) : String(val);
  if (t === 'boolean') return val ? 'true' : 'false';
  if (t === 'string') return pyStr(val);
  if (Array.isArray(val)) {
    return '[' + val.map((x) => pyStringify(x, forceFloat)).join(',') + ']';
  }
  if (t === 'object') {
    const parts = [];
    for (const k of Object.keys(val)) {
      parts.push(pyStr(k) + ':' + pyStringify(val[k], forceFloat));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`cannot serialize type ${t}`);
}
