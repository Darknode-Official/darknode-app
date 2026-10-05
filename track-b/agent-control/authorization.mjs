// DO-013 — Authorization record model.
//
// A target is NOT actionable until an authorization record exists. Scope
// (which targets, which activity classes, which time window, attested by whom)
// is defined ONLY by authorization records. It can never be derived from the
// agent's conversation, from content the agent reads, or from a tool result.
//
// This module is pure data + validation. It holds no policy decisions; the
// PolicyEngine (policy.mjs) is the sole decision point.

/** The three separately-authorized activity classes (DO-013). */
export const ActivityClass = Object.freeze({
  PASSIVE_LOOKUP: 'PASSIVE_LOOKUP',     // passive lookup (WHOIS, DNS, public records)
  MATERIAL_REVIEW: 'MATERIAL_REVIEW',   // review of user-supplied material
  ACTIVE_INTERACTION: 'ACTIVE_INTERACTION', // active interaction with live systems
});

/** Origin of an action request. Only OPERATOR origin may carry intent;
 *  CONTENT and TOOL_RESULT are data and can never widen scope. */
export const Origin = Object.freeze({
  OPERATOR: 'OPERATOR',
  CONTENT: 'CONTENT',         // text read from a target/file/tool output
  TOOL_RESULT: 'TOOL_RESULT', // structured result of a prior tool run
});

function isByte(n) { return Number.isInteger(n) && n >= 0 && n <= 255; }

/** Parse "a.b.c.d" to a uint32, or null if malformed. */
export function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (!isByte(b)) return null;
    v = (v * 256) + b;
  }
  return v >>> 0;
}

/** Does `ip` fall inside CIDR `a.b.c.d/len`? Pure, no side effects. */
export function cidrContains(cidr, ip) {
  if (typeof cidr !== 'string' || !cidr.includes('/')) return false;
  const [net, lenStr] = cidr.split('/');
  const len = Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > 32) return false;
  const netInt = ipToInt(net);
  const ipInt = ipToInt(ip);
  if (netInt === null || ipInt === null) return false;
  if (len === 0) return true;
  const mask = len === 32 ? 0xffffffff : (~((1 << (32 - len)) - 1)) >>> 0;
  return (netInt & mask) === (ipInt & mask);
}

/** Does a target identifier match an authorized scope entry?
 *  Scope entries are exact hostnames/domains, exact IPs, or IPv4 CIDRs.
 *  Domain scope "example.com" matches "example.com" and "*.example.com".
 *  No wildcards beyond that; no substring matching (prevents sneaky widening). */
export function targetMatches(scopeEntry, target) {
  if (typeof scopeEntry !== 'string' || typeof target !== 'string') return false;
  if (scopeEntry === target) return true;
  if (scopeEntry.includes('/')) return cidrContains(scopeEntry, target);
  // domain subtree match
  if (target.endsWith('.' + scopeEntry)) return true;
  return false;
}

/**
 * A validated, immutable authorization record. The constructor rejects
 * anything malformed so an invalid record can never reach the policy engine.
 */
export class AuthorizationRecord {
  constructor({ id, targets, activityClasses, notBefore, notAfter, attestingParty, allowDestructive = false }) {
    if (!id || typeof id !== 'string') throw new Error('authorization: id required');
    if (!Array.isArray(targets) || targets.length === 0) throw new Error('authorization: targets required');
    if (!Array.isArray(activityClasses) || activityClasses.length === 0) throw new Error('authorization: activityClasses required');
    for (const c of activityClasses) {
      if (!Object.values(ActivityClass).includes(c)) throw new Error('authorization: unknown activity class ' + c);
    }
    const nb = Number(notBefore), na = Number(notAfter);
    if (!Number.isFinite(nb) || !Number.isFinite(na) || na <= nb) throw new Error('authorization: invalid time window');
    if (!attestingParty || typeof attestingParty !== 'string') throw new Error('authorization: attestingParty required');
    this.id = id;
    this.targets = Object.freeze([...targets]);
    this.activityClasses = Object.freeze([...activityClasses]);
    this.notBefore = nb;
    this.notAfter = na;
    this.attestingParty = attestingParty;
    this.allowDestructive = !!allowDestructive;
    Object.freeze(this);
  }

  coversTarget(target) { return this.targets.some((s) => targetMatches(s, target)); }
  coversClass(activityClass) { return this.activityClasses.includes(activityClass); }
  activeAt(now) { return now >= this.notBefore && now <= this.notAfter; }
}
