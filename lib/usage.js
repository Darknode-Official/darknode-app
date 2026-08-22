"use strict";
// Per-project AI usage ledger + reporting. Large orgs need cost visibility and
// chargeback for AI-agent spend: how much, on which project, engine, model, and
// over what period. Every completed Nexus turn appends ONE non-sensitive metrics
// record (no prompt text, no file paths — just counts) to .nexus/usage.jsonl.
// summarize()/renderReport() aggregate it; both are pure so they are unit-tested.
// (The audit trail — .nexus/audit.jsonl — separately records the actions taken.)
const fs = require("fs"), path = require("path");

const MONEY = (n) => "$" + (Math.round((n || 0) * 1e4) / 1e4).toFixed(4);
const TOK = (n) => { n = n || 0; return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : "" + (n | 0); };

// appendUsage(cwd, record) — append one JSON line. Best-effort; never throws.
function appendUsage(cwd, rec) {
  try {
    const dir = path.join(cwd, ".nexus");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "usage.jsonl"), JSON.stringify(rec) + "\n");
    return true;
  } catch (_) { return false; }
}

// loadUsage(cwd, { since }) — parse the ledger; skips malformed lines. `since` is
// an ISO date/prefix string compared lexicographically against each record's ts.
function loadUsage(cwd, opts) {
  opts = opts || {};
  let raw;
  try { raw = fs.readFileSync(path.join(cwd, ".nexus", "usage.jsonl"), "utf8"); }
  catch (_) { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!opts.since || (typeof r.ts === "string" && r.ts >= opts.since)) out.push(r); } catch (_) {}
  }
  return out;
}

// summarize(records) -> aggregate totals + breakdowns by engine / model / day.
function summarize(records) {
  const s = { turns: 0, inTok: 0, outTok: 0, cost: 0, seconds: 0, files: 0, commands: 0, interrupted: 0,
    byEngine: {}, byModel: {}, byOperator: {}, byTeam: {}, byDay: {}, firstTs: null, lastTs: null };
  for (const r of records) {
    s.turns++;
    s.inTok += r.inTok || 0; s.outTok += r.outTok || 0; s.cost += r.cost || 0;
    s.seconds += r.seconds || 0; s.files += r.files || 0; s.commands += r.commands || 0;
    if (r.interrupted) s.interrupted++;
    const eng = r.engine || "unknown", mdl = r.model || eng;
    const e = s.byEngine[eng] || (s.byEngine[eng] = { turns: 0, cost: 0, inTok: 0, outTok: 0 });
    e.turns++; e.cost += r.cost || 0; e.inTok += r.inTok || 0; e.outTok += r.outTok || 0;
    const m = s.byModel[mdl] || (s.byModel[mdl] = { turns: 0, cost: 0 });
    m.turns++; m.cost += r.cost || 0;
    // attribution for chargeback: who ran it, and which team
    const op = (r.operator || "unknown");
    const o = s.byOperator[op] || (s.byOperator[op] = { turns: 0, cost: 0, inTok: 0, outTok: 0 });
    o.turns++; o.cost += r.cost || 0; o.inTok += r.inTok || 0; o.outTok += r.outTok || 0;
    if (r.team) { const tm = s.byTeam[r.team] || (s.byTeam[r.team] = { turns: 0, cost: 0 }); tm.turns++; tm.cost += r.cost || 0; }
    if (typeof r.ts === "string") {
      const day = r.ts.slice(0, 10);
      const d = s.byDay[day] || (s.byDay[day] = { turns: 0, cost: 0 });
      d.turns++; d.cost += r.cost || 0;
      if (!s.firstTs || r.ts < s.firstTs) s.firstTs = r.ts;
      if (!s.lastTs || r.ts > s.lastTs) s.lastTs = r.ts;
    }
  }
  return s;
}

// sort a { key: {cost,...} } map into rows, biggest spender first.
const ranked = (obj) => Object.keys(obj).map((k) => [k, obj[k]]).sort((a, b) => (b[1].cost - a[1].cost) || (b[1].turns - a[1].turns));

// renderReport(summary, { title, project }) -> plain-text report (no color, so it
// is deterministic and testable; the caller may colorize).
function renderReport(s, opts) {
  opts = opts || {};
  const L = [];
  L.push("Nexus usage report" + (opts.project ? " — " + opts.project : ""));
  const period = s.firstTs ? s.firstTs.slice(0, 10) + " → " + s.lastTs.slice(0, 10) : "no records yet";
  L.push("  Period      " + period + "   (" + s.turns + " turn" + (s.turns === 1 ? "" : "s") + (s.interrupted ? ", " + s.interrupted + " interrupted" : "") + ")");
  L.push("  Tokens      ↑" + TOK(s.inTok) + " in  ↓" + TOK(s.outTok) + " out");
  L.push("  Cost        " + MONEY(s.cost));
  L.push("  Activity    " + s.files + " file change" + (s.files === 1 ? "" : "s") + " · " + s.commands + " command" + (s.commands === 1 ? "" : "s") + " · " + Math.round(s.seconds) + "s of agent time");
  const eng = ranked(s.byEngine);
  if (eng.length) { L.push(""); L.push("  By engine"); for (const [k, v] of eng) L.push("    " + k.padEnd(12) + String(v.turns + " turn" + (v.turns === 1 ? "" : "s")).padEnd(12) + MONEY(v.cost).padEnd(12) + "↑" + TOK(v.inTok) + " ↓" + TOK(v.outTok)); }
  const mdl = ranked(s.byModel);
  if (mdl.length) { L.push(""); L.push("  By model"); for (const [k, v] of mdl) L.push("    " + k.padEnd(28) + String(v.turns).padEnd(6) + MONEY(v.cost)); }
  const team = ranked(s.byTeam || {});
  if (team.length) { L.push(""); L.push("  By team"); for (const [k, v] of team) L.push("    " + k.padEnd(20) + String(v.turns + " turn" + (v.turns === 1 ? "" : "s")).padEnd(12) + MONEY(v.cost)); }
  const ops = ranked(s.byOperator || {});
  if (ops.length > 1) { L.push(""); L.push("  By operator"); for (const [k, v] of ops) L.push("    " + k.padEnd(20) + String(v.turns + " turn" + (v.turns === 1 ? "" : "s")).padEnd(12) + MONEY(v.cost) + "   ↑" + TOK(v.inTok) + " ↓" + TOK(v.outTok)); }
  const days = Object.keys(s.byDay).sort();
  if (days.length) { L.push(""); L.push("  By day"); for (const d of days) L.push("    " + d + "   " + String(s.byDay[d].turns + " turn" + (s.byDay[d].turns === 1 ? "" : "s")).padEnd(10) + MONEY(s.byDay[d].cost)); }
  return L.join("\n");
}

module.exports = { appendUsage, loadUsage, summarize, renderReport, MONEY, TOK };
