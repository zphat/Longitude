// Tiny assertion helpers for the compress tests (no network imports needed).

export function assert(value, message = "assertion failed") {
  if (!value) throw Error(message);
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same(a[k], b[k]));
}

export function assertEquals(actual, expected, message = "") {
  if (!same(actual, expected)) {
    const show = (v) => {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };
    throw Error(`${message ? message + ": " : ""}expected ${show(expected)}, got ${show(actual)}`);
  }
}

export async function assertRejects(fn, pattern) {
  try {
    await fn();
  } catch (err) {
    if (pattern && !pattern.test(err.message)) throw Error(`wrong error: ${err.message}`);
    return err;
  }
  throw Error("expected a rejection");
}
