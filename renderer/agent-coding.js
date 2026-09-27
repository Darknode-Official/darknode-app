// agent-coding.js — the app home agent's on-machine coding brain.
// VENDORED VERBATIM (pure, no-fs logic only) from the darknode-cli Nexus engine:
//   lib/nexus/repo-map.js  — ranked repo map + symbol outline + go-to-symbol
//   lib/nexus/edit.js      — atomic multi-edit, whitespace-flexible match, unified-diff patch
//   lib/nexus/verify.js    — detect a project's own test/build/lint commands
// These are exactly the capabilities the browser (darknode.ai) can NEVER have: they operate on
// real files on this machine. All fs/shell here is done by the caller via the existing IPC bridge;
// this module is pure string logic, so it stays testable in Node too.
(function () {
  "use strict";

  // ============ vendored from darknode-cli/lib/nexus/repo-map.js ============

  // ================= repo-map: fast, dependency-free codebase orientation =================
  // Top coding agents (Claude Code, Codex, Devin) open a task already oriented: they know the
  // shape of the tree and the important symbols. Nexus previously only had keyword-overlap
  // retrieval (and only for the local engine). This module builds a compact, RANKED map of a
  // repository — a pruned file tree plus a per-file symbol outline (functions / classes /
  // exports) extracted by language-aware regexes — cheap enough to inject into the system
  // prompt every session, for EVERY engine.
  //
  // Pure and testable: `buildRepoMap` takes an array of { path, content } (or { path, size }),
  // never touches the filesystem itself, and returns a deterministic structure. `renderRepoMap`
  // turns it into a token-budgeted string. The caller (darknode.js) does the fs walk.

  // Directories that never carry signal for a coding task.
  const IGNORE_DIRS = new Set([
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "vendor",
    ".next", ".nuxt", ".cache", "coverage", "__pycache__", ".venv", "venv", "env",
    ".idea", ".vscode", ".gradle", ".terraform", "bin", "obj", ".pytest_cache",
    ".mypy_cache", ".tox", "bower_components", ".parcel-cache", ".turbo", ".svelte-kit",
  ]);

  // Files that are noise (locks, minified bundles, maps, binaries by extension).
  const IGNORE_FILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$|\.(min\.js|min\.css|map|lock)$/i;
  const BINARY_EXT_RE = /\.(png|jpe?g|gif|bmp|ico|webp|svg|pdf|zip|gz|tar|tgz|bz2|xz|7z|rar|exe|dll|so|dylib|o|a|class|jar|war|wasm|bin|dat|db|sqlite3?|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|wav|flac|ogg|psd|ai|sketch)$/i;

  // Language detection by extension → symbol-extraction rules.
  const EXT_LANG = {
    js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts",
    py: "py", pyi: "py", rb: "rb", go: "go", rs: "rs", java: "java",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "cs", php: "php", swift: "swift", kt: "kt", scala: "scala",
    sh: "sh", bash: "sh", lua: "lua", ex: "ex", exs: "ex", dart: "dart",
    vue: "js", svelte: "js",
  };

  function extOf(p) { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1].toLowerCase() : ""; }
  function baseOf(p) { const s = String(p).replace(/\/+$/, ""); const i = s.lastIndexOf("/"); return i < 0 ? s : s.slice(i + 1); }

  // Is this a path we should even consider for the map?
  function isSourceFile(p) {
    if (IGNORE_FILE_RE.test(p) || BINARY_EXT_RE.test(p)) return false;
    for (const seg of String(p).split("/")) if (IGNORE_DIRS.has(seg)) return false;
    return true;
  }

  // Per-language symbol matchers. Each returns [{ kind, name, line }]. Regexes are intentionally
  // forgiving: a repo map is a hint, not a compiler, so a few misses/false-positives are fine as
  // long as the output is stable and the common declarations are caught.
  const SYMBOL_RULES = {
    js: [
      [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "fn"],
      [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
      [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "fn"],
      [/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, "method"],
      [/^\s*module\.exports\s*=/, "exports"],
    ],
    py: [
      [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, "fn"],
      [/^\s*class\s+([A-Za-z_][\w]*)/, "class"],
    ],
    rb: [
      [/^\s*def\s+([A-Za-z_][\w?!]*)/, "fn"],
      [/^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/, "class"],
    ],
    go: [
      [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, "fn"],
      [/^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/, "type"],
    ],
    rs: [
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, "fn"],
      [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, "type"],
      [/^\s*impl(?:\s*<[^>]*>)?\s+([A-Za-z_][\w:]*)/, "impl"],
    ],
    java: [
      [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_][\w]*)/, "class"],
      [/^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+([A-Za-z_][\w]*)\s*\(/, "method"],
    ],
    c: [[/^[A-Za-z_][\w\s\*]*\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/, "fn"]],
    php: [
      [/^\s*(?:public|private|protected|static|abstract|final|\s)*function\s+([A-Za-z_][\w]*)/, "fn"],
      [/^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/, "class"],
    ],
    sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/, "fn"]],
  };
  SYMBOL_RULES.ts = SYMBOL_RULES.js.concat([
    [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, "type"],
    [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, "type"],
    [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, "type"],
  ]);
  SYMBOL_RULES.cpp = SYMBOL_RULES.c.concat([[/^\s*(?:class|struct)\s+([A-Za-z_][\w]*)/, "class"]]);

  // Language keywords that the forgiving "method" / call-shaped regexes would otherwise capture as
  // bogus symbols (`if (...) {`, `for (...) {`, `catch (e) {`, `switch (x) {`, …).
  const KEYWORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "do", "else", "with", "function", "class",
    "try", "finally", "case", "default", "typeof", "instanceof", "new", "delete", "void", "in",
    "of", "await", "yield", "throw", "super", "this", "constructor", "get", "set", "static",
    "def", "elif", "except", "lambda", "and", "or", "not", "func", "fn", "let", "const", "var",
    "foreach", "unless", "when", "match", "select", "go", "defer", "using", "namespace",
  ]);

  // Extract symbols from one file's content. Skips comment-only / string-heavy lines cheaply and
  // dedups by name (keeping the first sighting) so a class + its methods don't dominate.
  function extractSymbols(pathOrExt, content, opts) {
    const lang = EXT_LANG[extOf(pathOrExt)] || EXT_LANG[pathOrExt] || null;
    const rules = lang && SYMBOL_RULES[lang];
    if (!rules || typeof content !== "string") return [];
    const cap = (opts && opts.max) || 40;
    const out = [], seen = new Set();
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 400) continue; // minified / data line
      for (const [re, kind] of rules) {
        const m = re.exec(line);
        if (m && m[1] && !KEYWORDS.has(m[1]) && !seen.has(kind + " " + m[1])) {
          seen.add(kind + " " + m[1]);
          out.push({ kind, name: m[1], line: i + 1 });
          break;
        }
      }
      if (out.length >= cap) break;
    }
    return out;
  }

  // Score a file for how likely it matters to a coding task: entry points and files with many
  // symbols rank high; tests, config and generated-ish paths rank low. Higher = more important.
  function scoreFile(f) {
    const p = f.path, b = baseOf(p).toLowerCase();
    let s = 0;
    const nSym = f.symbols ? f.symbols.length : 0;
    s += Math.min(nSym, 30); // symbol density is the main signal
    if (/^(index|main|app|server|cli|mod|lib)\.[a-z]+$/.test(b)) s += 12; // entry points
    if (/(^|\/)(src|lib|app|pkg|internal)\//.test(p)) s += 4; // canonical source dirs
    const depth = p.split("/").length; s -= Math.max(0, depth - 2); // shallow files matter more
    if (/(^|\/)(test|tests|spec|__tests__|e2e|fixtures?)(\/|$)/i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(b)) s -= 6;
    if (/(^|\/)(docs?|examples?|samples?|demos?)(\/|$)/i.test(p)) s -= 4;
    if (/\.(json|ya?ml|toml|ini|cfg|conf|lock|md|txt|xml|env)$/i.test(b)) s -= 3; // config/docs
    if (/(readme|license|changelog|contributing)/i.test(b)) s -= 2;
    return s;
  }

  // Build the map from an array of { path, content?, size? }. Files without content still appear
  // in the tree (and can be scored/sized) but contribute no symbols.
  function buildRepoMap(files, opts) {
    opts = opts || {};
    const symMax = opts.symbolsPerFile || 40;
    const kept = [];
    for (const f of files || []) {
      if (!f || typeof f.path !== "string" || !f.path) continue;
      if (!isSourceFile(f.path)) continue;
      const symbols = typeof f.content === "string" ? extractSymbols(f.path, f.content, { max: symMax }) : [];
      const size = typeof f.size === "number" ? f.size : (typeof f.content === "string" ? f.content.length : 0);
      const rec = { path: f.path.replace(/^\.\//, ""), size, symbols, lang: EXT_LANG[extOf(f.path)] || null };
      rec.score = scoreFile(rec);
      kept.push(rec);
    }
    kept.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const langs = {};
    for (const f of kept) if (f.lang) langs[f.lang] = (langs[f.lang] || 0) + 1;
    return {
      fileCount: kept.length,
      symbolCount: kept.reduce((n, f) => n + f.symbols.length, 0),
      languages: langs,
      files: kept,
    };
  }

  // Render a token-budgeted text view. `maxFiles` files are shown with up to `maxSymbols` symbols
  // each; the rest are summarized as a count. Deterministic, compact, prompt-ready.
  function renderRepoMap(map, opts) {
    opts = opts || {};
    const maxFiles = opts.maxFiles || 40;
    const maxSym = opts.maxSymbols || 12;
    if (!map || !map.files || !map.files.length) return "(empty repository map)";
    const langLine = Object.entries(map.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => l + " x" + n).join(", ");
    const lines = [];
    lines.push("Repository map: " + map.fileCount + " source files, " + map.symbolCount + " symbols" + (langLine ? " (" + langLine + ")" : "") + ".");
    const shown = map.files.slice(0, maxFiles);
    for (const f of shown) {
      const syms = f.symbols.slice(0, maxSym).map((s) => s.name + (s.kind === "class" || s.kind === "type" ? "*" : "")).join(", ");
      const more = f.symbols.length > maxSym ? " +" + (f.symbols.length - maxSym) : "";
      lines.push("  " + f.path + (syms ? "  — " + syms + more : ""));
    }
    if (map.files.length > maxFiles) lines.push("  … and " + (map.files.length - maxFiles) + " more files.");
    return lines.join("\n");
  }

  // Find where a symbol is defined across a built map. Ranks exact-name definitions first, then
  // case-insensitive, then substring — so "where is fooBar defined" lands on the definition, not a
  // mention. Returns [{ path, name, kind, line }]. This is agentic "go to definition" without an LSP.
  function findSymbol(map, name, opts) {
    opts = opts || {};
    const q = String(name || "").trim();
    if (!q || !map || !map.files) return [];
    const ql = q.toLowerCase();
    const hits = [];
    for (const f of map.files) {
      for (const s of f.symbols || []) {
        const nl = s.name.toLowerCase();
        let rank = null;
        if (s.name === q) rank = 0;
        else if (nl === ql) rank = 1;
        else if (opts.fuzzy !== false && nl.includes(ql) && ql.length >= 3) rank = 2;
        if (rank !== null) hits.push({ path: f.path, name: s.name, kind: s.kind, line: s.line, rank });
      }
    }
    hits.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path) || a.line - b.line);
    return hits.slice(0, opts.limit || 25).map(({ rank, ...rest }) => rest); // eslint-disable-line no-unused-vars
  }



  // ============ vendored from darknode-cli/lib/nexus/edit.js ============

  // ================= edit: reliable code edits (multi-edit · flexible match · patch) =================
  // Nexus's local agent edited files with a single literal find/replace. That is safe but brittle:
  // weak models miscount whitespace, want several edits at once, or emit a unified diff. This module
  // makes edits land without becoming unsafe:
  //   - applyEdits(content, edits)        atomic multi-edit (all-or-nothing), literal, uniqueness-checked
  //   - locateFlexible(content, find)     whitespace-flexible line match, ONLY when it is unambiguous
  //   - applyEditsFlexible(content, edits) exact first, then a single-match flexible fallback
  //   - parsePatch(patch) / applyPatch    apply a unified diff by ANCHORING on context (drift-proof)
  // Everything is pure (string in, string out) and covered by test/run.js. The guiding rule matches
  // the rest of Nexus: never guess. A find that is missing, or that matches two places, is an ERROR,
  // never a silent edit.

  // ---- literal, atomic multi-edit --------------------------------------------------------------
  // edits: [{ find, replace, replaceAll? }]. Applied in order against the evolving content. Fails
  // (touching nothing) if any find is absent, or matches >1 place without replaceAll.
  function applyEdits(content, edits) {
    if (typeof content !== "string") return { ok: false, error: "content must be a string" };
    if (!Array.isArray(edits) || !edits.length) return { ok: false, error: "no edits given" };
    let out = content; const applied = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] || {};
      const find = e.find, repl = e.replace == null ? "" : e.replace;
      if (typeof find !== "string" || !find.length) return { ok: false, error: "edit " + (i + 1) + ": empty find", applied: [] };
      if (find === repl) return { ok: false, error: "edit " + (i + 1) + ": find and replace are identical", applied: [] };
      const occ = out.split(find).length - 1;
      if (occ === 0) return { ok: false, error: "edit " + (i + 1) + ": find text not present — check exact whitespace/indentation", applied: [] };
      if (occ > 1 && !e.replaceAll) return { ok: false, error: "edit " + (i + 1) + ": find matches " + occ + " places — add context to make it unique, or set replaceAll", applied: [] };
      out = e.replaceAll ? out.split(find).join(repl) : out.replace(find, repl);
      applied.push({ find: find.slice(0, 40), count: e.replaceAll ? occ : 1 });
    }
    return { ok: true, content: out, applied };
  }

  const normWs = (l) => l.replace(/\s+/g, " ").trim();
  // Leading whitespace of the first non-empty line, and a re-indent that shifts every non-empty line
  // by `delta` columns (adding spaces, or stripping leading whitespace). Used so a flexible/patch
  // replacement that omitted indentation lands at the indentation of the block it replaced.
  const leadWs = (s) => { const first = String(s).split("\n").find((l) => l.trim() !== "") || ""; return (first.match(/^\s*/) || [""])[0]; };
  const reindentBlock = (text, delta) => { if (!delta) return text; return String(text).split("\n").map((l) => { if (l.trim() === "") return l; if (delta > 0) return " ".repeat(delta) + l; let k = 0; while (k < -delta && k < l.length && /\s/.test(l[k])) k++; return l.slice(k); }).join("\n"); };

  // Locate `find` in `content` ignoring per-line indentation and internal whitespace runs, matching
  // on whole lines. Returns { count, start, end } (char offsets of the matched line block) when the
  // block occurs exactly once; count:0 or count>1 otherwise. Never returns a location when ambiguous.
  function locateFlexible(content, find) {
    const cLines = content.split("\n");
    let fLines = String(find).split("\n");
    while (fLines.length && fLines[fLines.length - 1].trim() === "") fLines.pop();
    while (fLines.length && fLines[0].trim() === "") fLines.shift();
    if (!fLines.length) return { count: 0 };
    const fNorm = fLines.map(normWs);
    const hits = [];
    for (let i = 0; i + fNorm.length <= cLines.length; i++) {
      let ok = true;
      for (let j = 0; j < fNorm.length; j++) if (normWs(cLines[i + j]) !== fNorm[j]) { ok = false; break; }
      if (ok) hits.push(i);
    }
    if (hits.length !== 1) return { count: hits.length };
    // char offsets of the matched block (join with the same \n the split used)
    const startLine = hits[0], endLine = hits[0] + fNorm.length;
    const start = cLines.slice(0, startLine).reduce((n, l) => n + l.length + 1, 0);
    const end = start + cLines.slice(startLine, endLine).join("\n").length;
    return { count: 1, start, end, startLine, indent: (cLines[startLine].match(/^\s*/) || [""])[0] };
  }

  // Exact multi-edit first; for any edit whose literal find is absent, fall back to a SINGLE-match
  // flexible locate and replace that block verbatim (re-indented to the matched block when the
  // replacement carries no indentation of its own). Reports the mode of each applied edit.
  function applyEditsFlexible(content, edits) {
    const exact = applyEdits(content, edits);
    if (exact.ok) return { ok: true, content: exact.content, applied: exact.applied.map((a) => Object.assign({ mode: "exact" }, a)) };
    if (typeof content !== "string" || !Array.isArray(edits) || !edits.length) return exact;
    let out = content; const applied = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] || {};
      const find = e.find, repl = e.replace == null ? "" : e.replace;
      if (typeof find !== "string" || !find.length) return { ok: false, error: "edit " + (i + 1) + ": empty find", applied: [] };
      const occ = out.split(find).length - 1;
      if (occ === 1 || (occ > 1 && e.replaceAll)) { out = e.replaceAll ? out.split(find).join(repl) : out.replace(find, repl); applied.push({ mode: "exact", count: occ }); continue; }
      if (occ > 1) return { ok: false, error: "edit " + (i + 1) + ": matches " + occ + " places — add context or replaceAll", applied: [] };
      const loc = locateFlexible(out, find);
      if (loc.count === 0) return { ok: false, error: "edit " + (i + 1) + ": find text not present (even ignoring whitespace)", applied: [] };
      if (loc.count > 1) return { ok: false, error: "edit " + (i + 1) + ": whitespace-flexible match is ambiguous (" + loc.count + " places) — add context", applied: [] };
      const delta = loc.indent.length - leadWs(find).length;
      out = out.slice(0, loc.start) + reindentBlock(repl, delta) + out.slice(loc.end);
      applied.push({ mode: "flexible", count: 1 });
    }
    return { ok: true, content: out, applied };
  }

  // ---- unified-diff patching -------------------------------------------------------------------
  // Split a unified diff into per-file patches. Understands `diff --git`, `--- a/x`/`+++ b/x`
  // headers and @@ hunks. Returns [{ file, hunks:[{ before:[lines], after:[lines] }] }].
  function parsePatch(patch) {
    const lines = String(patch).replace(/\r/g, "").split("\n");
    const filesOut = []; let cur = null, hunk = null;
    const closeHunk = () => { if (hunk && cur) cur.hunks.push(hunk); hunk = null; };
    const closeFile = () => { closeHunk(); if (cur && cur.hunks.length) filesOut.push(cur); cur = null; };
    for (const raw of lines) {
      if (/^diff --git /.test(raw)) { closeFile(); cur = { file: null, hunks: [] }; continue; }
      let m;
      if ((m = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(raw))) { if (!cur) cur = { file: null, hunks: [] }; if (m[1] !== "/dev/null") cur.file = m[1]; continue; }
      if (/^--- /.test(raw)) { if (!cur) cur = { file: null, hunks: [] }; const mm = /^--- (?:a\/)?(.+?)\s*$/.exec(raw); if (mm && mm[1] !== "/dev/null" && !cur.file) cur.file = mm[1]; continue; }
      if (/^@@/.test(raw)) { closeHunk(); if (!cur) cur = { file: null, hunks: [] }; hunk = { before: [], after: [] }; continue; }
      if (!hunk) continue;
      const tag = raw[0], body = raw.slice(1);
      if (tag === " ") { hunk.before.push(body); hunk.after.push(body); }
      else if (tag === "-") { hunk.before.push(body); }
      else if (tag === "+") { hunk.after.push(body); }
      else if (raw === "\\ No newline at end of file") { /* ignore */ }
      // any other line ends the hunk implicitly
      else { closeHunk(); }
    }
    closeFile();
    return filesOut;
  }

  // Apply one file's hunks to its content by ANCHORING each hunk's `before` block via exact then
  // flexible locate — so mismatched @@ line numbers don't matter. All-or-nothing per file.
  function applyHunks(content, hunks) {
    if (typeof content !== "string") return { ok: false, error: "content must be a string" };
    let out = content;
    for (let h = 0; h < hunks.length; h++) {
      const before = hunks[h].before.join("\n"), after = hunks[h].after.join("\n");
      if (before === after) continue;
      if (!before.length) { // pure insertion with no context: only safe for a brand-new/empty file
        if (out.length) return { ok: false, error: "hunk " + (h + 1) + ": no context to anchor an insertion" };
        out = after; continue;
      }
      const occ = out.split(before).length - 1;
      if (occ === 1) { out = out.replace(before, after); continue; }
      if (occ > 1) return { ok: false, error: "hunk " + (h + 1) + ": context matches " + occ + " places — patch is ambiguous" };
      const loc = locateFlexible(out, before);
      if (loc.count === 1) { const delta = loc.indent.length - leadWs(before).length; out = out.slice(0, loc.start) + reindentBlock(after, delta) + out.slice(loc.end); continue; }
      return { ok: false, error: "hunk " + (h + 1) + ": context not found in file" + (loc.count > 1 ? " (ambiguous)" : "") };
    }
    return { ok: true, content: out };
  }

  // Convenience: apply a single-file unified diff string to content.
  function applyPatch(content, patch) {
    const files = parsePatch(patch);
    if (!files.length) return { ok: false, error: "no hunks parsed from the patch" };
    if (files.length > 1) return { ok: false, error: "patch touches " + files.length + " files — apply per file with parsePatch/applyHunks" };
    return applyHunks(content, files[0].hunks);
  }



  // ============ vendored from darknode-cli/lib/nexus/verify.js ============

  // ================= verify: detect a project's test / build / lint commands =================
  // Devin's edge is a tight edit → run → observe → fix loop. Nexus could only do this via the
  // opt-in /watch command. This module gives Nexus the first half for free: from the files at the
  // repo root it infers the RIGHT command to run (the project's own test runner, then build, then
  // lint / typecheck), so the agent can verify its own change instead of declaring success blind.
  //
  // Pure and testable: `detectProjectCommands(entries, files)` takes the list of root entry names
  // and an optional { name: contentString } map (only package.json / Makefile content is used) and
  // returns { test?, build?, lint?, typecheck?, source, pm }. `pickVerify` chooses the single most
  // meaningful command to gate on. No filesystem access here — the caller does the walk + spawn.

  function detectPackageManager(entries) {
    if (entries.includes("bun.lockb")) return "bun";
    if (entries.includes("pnpm-lock.yaml")) return "pnpm";
    if (entries.includes("yarn.lock")) return "yarn";
    return "npm";
  }

  function detectProjectCommands(entries, files) {
    entries = entries || []; files = files || {};
    const has = (n) => entries.includes(n);
    const out = {};
    const pm = detectPackageManager(entries);

    if (has("package.json")) {
      let pkg = {}; try { pkg = JSON.parse(files["package.json"] || "{}") || {}; } catch (_) { pkg = {}; }
      const s = pkg.scripts || {};
      // `npm test`/`yarn test`/`pnpm test`/`bun test` are the idiomatic test invocations; other
      // scripts go through `run`.
      const runScript = (name) => (pm === "npm" ? "npm run " + name : pm === "yarn" ? "yarn " + name : pm + " run " + name);
      const testInvoke = pm === "npm" ? "npm test" : pm === "bun" ? "bun test" : pm + " test";
      if (s.test) out.test = testInvoke;
      else if (s["test:unit"]) out.test = runScript("test:unit");
      else if (s["test:ci"]) out.test = runScript("test:ci");
      if (s.build) out.build = runScript("build");
      if (s.lint) out.lint = runScript("lint");
      if (s.typecheck) out.typecheck = runScript("typecheck");
      else if (s["type-check"]) out.typecheck = runScript("type-check");
      else if (s.tsc) out.typecheck = runScript("tsc");
      else if (has("tsconfig.json")) out.typecheck = (pm === "npm" ? "npx" : pm === "yarn" ? "yarn" : pm === "bun" ? "bunx" : "pnpm exec") + " tsc --noEmit";
      out.pm = pm; out.source = "package.json";
    }
    // Python
    if (!out.test && (has("pytest.ini") || has("tox.ini") || has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("conftest.py") || has("tests") || has("test"))) {
      out.test = "pytest -q"; out.source = out.source || "python";
    }
    // Rust
    if (has("Cargo.toml")) { if (!out.test) out.test = "cargo test"; if (!out.build) out.build = "cargo build"; out.source = out.source || "cargo"; }
    // Go
    if (has("go.mod")) { if (!out.test) out.test = "go test ./..."; if (!out.build) out.build = "go build ./..."; if (!out.lint) out.lint = "go vet ./..."; out.source = out.source || "go"; }
    // Ruby
    if (!out.test && has("Gemfile")) { out.test = has(".rspec") || has("spec") ? "bundle exec rspec" : "bundle exec rake test"; out.source = out.source || "ruby"; }
    // Make (only if it actually declares the target)
    const mk = files["Makefile"] || files["makefile"] || files["GNUmakefile"] || "";
    if (mk) {
      if (!out.test && /^test\s*:/m.test(mk)) out.test = "make test";
      if (!out.build && /^build\s*:/m.test(mk)) out.build = "make build";
      if (!out.lint && /^lint\s*:/m.test(mk)) out.lint = "make lint";
      out.source = out.source || "make";
    }
    // Gradle / Maven (JVM)
    if (!out.test && (has("gradlew") || has("build.gradle") || has("build.gradle.kts"))) { out.test = (has("gradlew") ? "./gradlew" : "gradle") + " test"; out.source = out.source || "gradle"; }
    if (!out.test && has("pom.xml")) { out.test = "mvn -q test"; out.build = out.build || "mvn -q package"; out.source = out.source || "maven"; }

    return out;
  }

  // Choose the single command that best proves a change is good: a real test suite first, then a
  // build (compiles = at least not broken), then typecheck, then lint. Returns { kind, cmd } or null.
  function pickVerify(cmds) {
    if (!cmds) return null;
    for (const kind of ["test", "build", "typecheck", "lint"]) if (cmds[kind]) return { kind, cmd: cmds[kind] };
    return null;
  }



  const API = { buildRepoMap, renderRepoMap, extractSymbols, findSymbol, isSourceFile, scoreFile, IGNORE_DIRS, EXT_LANG, applyEdits, applyEditsFlexible, locateFlexible, parsePatch, applyHunks, applyPatch, normWs, detectProjectCommands, pickVerify, detectPackageManager };
  if (typeof window !== "undefined") window.NEXUS_CODE = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
