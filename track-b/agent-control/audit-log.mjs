// DO-013 — Append-only system audit log.
//
// Every tool invocation, file write, network action, and privilege decision is
// recorded here. The agent cannot rewrite it: the only public mutation is
// append(). Entries are hash-chained, so any out-of-band tampering with a
// prior entry is detectable by verify().
//
// In the shipping OS this is a kernel/journald-backed append-only sink; here it
// is an in-process reference implementation with the same contract, used by the
// policy engine and exercised by the test suite.

import { createHash } from 'node:crypto';

const GENESIS = '0'.repeat(64);

function hashEntry(prevHash, record) {
  const h = createHash('sha256');
  h.update(prevHash);
  h.update('\n');
  h.update(JSON.stringify(record));
  return h.digest('hex');
}

export class AppendOnlyAuditLog {
  #entries = [];        // private: not reachable or rewritable from outside
  #tip = GENESIS;

  /** Append a record. Returns the sealed entry (frozen). Never mutates history. */
  append(record) {
    const seq = this.#entries.length;
    const ts = typeof record.ts === 'number' ? record.ts : Date.now();
    const body = { seq, ts, ...record };
    const hash = hashEntry(this.#tip, body);
    const entry = Object.freeze({ ...body, prevHash: this.#tip, hash });
    this.#entries.push(entry);
    this.#tip = hash;
    return entry;
  }

  /** Read-only snapshot. Callers get frozen copies; mutating them does nothing. */
  entries() { return this.#entries.map((e) => Object.freeze({ ...e })); }

  get length() { return this.#entries.length; }
  get tip() { return this.#tip; }

  /** Recompute the chain and confirm no prior entry was altered. */
  verify() {
    let prev = GENESIS;
    for (const e of this.#entries) {
      const { prevHash, hash, ...body } = e;
      if (prevHash !== prev) return false;
      if (hashEntry(prev, body) !== hash) return false;
      prev = hash;
    }
    return true;
  }
}
