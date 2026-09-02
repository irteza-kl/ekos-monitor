'use strict';

/**
 * A tiny per-query cache for the endpoints that aggregate over every heartbeat
 * in range.
 *
 * Those cost seconds, the pages reload them on every auto-refresh tick and on
 * every filter click, and the data behind them is minutes old anyway - so a
 * short cache costs nothing in accuracy and is the difference between a page
 * that answers instantly and one that stalls.
 *
 * Keyed by the whole filter query, because two different filters are two
 * different answers. `refresh=1` bypasses it, which is what the Refresh button
 * sends. Bounded so a page cycling through filters cannot grow it without end,
 * and evicted oldest-first.
 *
 * Deliberately in-process: this runs one Express app per instance and holds no
 * cross-request state otherwise. On a serverless deployment each instance keeps
 * its own copy and a cold one starts empty, so this speeds up a session rather
 * than the first visit of the day.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_KEYS = 8;

/** Ignored when building a key: they change the response's freshness, not its content. */
const IGNORED_PARAMS = new Set(['refresh', '_']);

function keyOf(query) {
  const q = query || {};
  const entries = Object.keys(q)
    .filter((k) => !IGNORED_PARAMS.has(k))
    .sort()
    .map((k) => [k, q[k]]);
  return JSON.stringify(entries);
}

/**
 * @param {{ttlMs?: number, maxKeys?: number}} [options]
 * @returns {{through: (query: object, load: () => Promise<any>) => Promise<any>, clear: () => void, size: () => number}}
 */
function create(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const maxKeys = options.maxKeys || DEFAULT_MAX_KEYS;
  const store = new Map();
  // Requests for the same key that arrive while the first is still running wait
  // for it instead of starting their own. The Overview page fires several
  // endpoints at once, so without this a slow aggregation can run twice.
  const inFlight = new Map();

  async function through(query, load) {
    const key = keyOf(query);
    const fresh = (query || {}).refresh === '1';

    if (!fresh) {
      const hit = store.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.data;
      const pending = inFlight.get(key);
      if (pending) return pending;
    }

    const promise = (async () => {
      const data = await load();
      if (store.size >= maxKeys) store.delete(store.keys().next().value);
      store.set(key, { at: Date.now(), data });
      return data;
    })();

    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    through,
    clear: () => store.clear(),
    size: () => store.size,
  };
}

module.exports = { create, keyOf, DEFAULT_TTL_MS };
