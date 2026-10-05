// DO-013 — Capability / policy enforcement, BELOW the UI.
//
// This is the single chokepoint. The agent is untrusted: a confused or
// compromised agent must be stopped here, not by its own good behavior. The
// agent can perform an action ONLY by (1) asking the PolicyEngine to authorize
// it and (2) handing the resulting signed grant to the Executor. The Executor
// refuses any action without a valid, matching, unexpired grant — so there is
// no "just do it" path around the engine.
//
// Scope comes ONLY from AuthorizationRecords held by the engine. Nothing in an
// action request (its target, its text, an embedded "authorization" field it
// may carry from injected content) can add or widen scope. CONTENT and
// TOOL_RESULT origins are treated as data, never as instructions to expand.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthorizationRecord, Origin, ActivityClass } from './authorization.mjs';

function canonical(action) {
  // The exact action a grant is bound to. Any divergence invalidates the grant.
  return JSON.stringify({
    activityClass: action.activityClass,
    target: action.target,
    tool: action.tool,
    destructive: !!action.destructive,
  });
}

export class PolicyEngine {
  #records = new Map();   // authorization records — the ONLY source of scope
  #secret;                // kernel-side secret; never exposed to the agent
  #log;

  constructor({ auditLog, secret } = {}) {
    if (!auditLog) throw new Error('PolicyEngine requires an audit log');
    this.#log = auditLog;
    this.#secret = secret || randomBytes(32);
  }

  /**
   * Install an authorization record. This is a PRIVILEGED out-of-band channel
   * (operator-attested), deliberately separate from authorize(): an action
   * request can never reach this. Rejects non-AuthorizationRecord input so a
   * plain object smuggled from content cannot masquerade as a grant of scope.
   */
  addAuthorization(record) {
    if (!(record instanceof AuthorizationRecord)) {
      throw new Error('addAuthorization: only validated AuthorizationRecord instances accepted');
    }
    this.#records.set(record.id, record);
    this.#log.append({ kind: 'AUTHORIZATION_INSTALLED', recordId: record.id,
      targets: record.targets, activityClasses: record.activityClasses,
      attestingParty: record.attestingParty });
    return record.id;
  }

  #sign(action, nonce, expiry) {
    const mac = createHmac('sha256', this.#secret);
    mac.update(canonical(action));
    mac.update('|'); mac.update(nonce);
    mac.update('|'); mac.update(String(expiry));
    return mac.digest('hex');
  }

  /**
   * Decide whether `action` is permitted right now. Returns
   * { allowed, reason, grant? }. Always logs the decision (allow or deny).
   */
  authorize(action, now = Date.now()) {
    const deny = (reason) => {
      this.#log.append({ kind: 'ACTION_DENIED', reason, origin: action.origin,
        activityClass: action.activityClass, target: action.target, tool: action.tool });
      return { allowed: false, reason };
    };

    // Structural checks.
    if (!action || typeof action !== 'object') return deny('malformed-action');
    if (!Object.values(ActivityClass).includes(action.activityClass)) return deny('unknown-activity-class');
    if (!action.target || typeof action.target !== 'string') return deny('no-target');

    // Scope can never come from data. An action that arrived as CONTENT or
    // TOOL_RESULT and tries to carry its own authorization is refused outright,
    // and such an origin can still only ever act within pre-existing records.
    if (action.origin !== Origin.OPERATOR) {
      if ('authorization' in action || 'grantScope' in action || 'escalate' in action) {
        return deny('scope-assertion-from-data-rejected');
      }
    }
    // Even an OPERATOR action may not inline its own scope grant.
    if ('authorization' in action) return deny('inline-authorization-rejected');

    // Find an active record that covers this exact target + activity class.
    let covering = null;
    for (const rec of this.#records.values()) {
      if (!rec.activeAt(now)) continue;
      if (!rec.coversClass(action.activityClass)) continue;
      if (!rec.coversTarget(action.target)) continue;
      covering = rec; break;
    }
    if (!covering) {
      // Distinguish the common failure modes for a readable audit trail.
      const anyTarget = [...this.#records.values()].some((r) => r.coversTarget(action.target));
      if (!anyTarget) return deny('target-not-authorized');
      const anyActive = [...this.#records.values()].some((r) => r.coversTarget(action.target) && r.activeAt(now));
      if (!anyActive) return deny('outside-time-window');
      return deny('activity-class-not-authorized');
    }

    // Destructive actions require explicit operator confirmation AND a record
    // that permits them.
    if (action.destructive) {
      if (!covering.allowDestructive) return deny('destructive-not-permitted-by-record');
      if (action.confirmedByOperator !== true) return deny('destructive-requires-confirmation');
    }

    // Allowed: issue a signed, action-bound, short-lived grant.
    const nonce = randomBytes(12).toString('hex');
    const expiry = now + 30_000; // 30s window to execute
    const sig = this.#sign(action, nonce, expiry);
    const grant = { nonce, expiry, sig, recordId: covering.id };
    this.#log.append({ kind: 'ACTION_AUTHORIZED', recordId: covering.id,
      origin: action.origin, activityClass: action.activityClass,
      target: action.target, tool: action.tool, destructive: !!action.destructive });
    return { allowed: true, reason: 'authorized', grant };
  }

  /** Internal: used by the Executor (same trust domain) to validate a grant. */
  _verifyGrant(action, grant, now = Date.now()) {
    if (!grant || typeof grant !== 'object') return false;
    if (typeof grant.sig !== 'string' || typeof grant.nonce !== 'string') return false;
    if (!Number.isFinite(grant.expiry) || now > grant.expiry) return false;
    const expected = this.#sign(action, grant.nonce, grant.expiry);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(grant.sig, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * The only thing that actually performs actions. It will not run anything
 * without a valid grant issued by THIS engine for THIS exact action. A
 * compromised agent calling run() with no grant, a forged grant, or a grant
 * for a different action is refused and the attempt is logged.
 */
export class Executor {
  #engine; #log;
  constructor(engine, auditLog) { this.#engine = engine; this.#log = auditLog; }

  run(action, grant, now = Date.now()) {
    if (!this.#engine._verifyGrant(action, grant, now)) {
      this.#log.append({ kind: 'EXECUTION_BLOCKED', reason: 'invalid-or-missing-grant',
        target: action && action.target, tool: action && action.tool });
      throw new Error('Executor: refused — no valid grant for this action');
    }
    this.#log.append({ kind: 'EXECUTION_OK', target: action.target, tool: action.tool,
      activityClass: action.activityClass, destructive: !!action.destructive });
    return { executed: true, target: action.target, tool: action.tool };
  }
}
