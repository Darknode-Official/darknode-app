// Sentinel desktop - Electron main process. Runs shell commands (streamed),
// checks installed tools, and proxies local Ollama. Renderer has no Node access
// (contextIsolation) and talks only through the preload bridge.
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { spawn, execFile } = require("child_process");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const dns = require("dns").promises;
const fs = require("fs");
// AI + enterprise governance (vendored from the Sentinel CLI)
const { toAnthropicBody, anthropicDelta, usageOf } = require("./lib/anthropic");
const { resolveOperator } = require("./lib/identity");
const { appendUsage, loadUsage, summarize, renderReport } = require("./lib/usage");
const { buildBundle, verifyBundle, renderBundleMd } = require("./lib/compliance");

const RESULTS_DIR = path.join(os.homedir(), "sentinel-results");

let nodePty = null;
try { nodePty = require("node-pty"); } catch (e) { console.error("[sentinel] node-pty unavailable:", e.message); }
console.log("[sentinel] node-pty:", nodePty ? "loaded" : "unavailable");

const isWin = process.platform === "win32";
let win;
const procs = new Map();
const ptys = new Map();
let ptySeq = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 840, minWidth: 900, minHeight: 600,
    backgroundColor: "#06080f",
    icon: path.join(__dirname, "renderer", "icon.png"),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,   // enables the built-in Browser section (<webview>)
    },
  });
  win.setMenuBarVisibility(false);
  win.on("maximize", () => win.webContents.send("win:state", true));
  win.on("unmaximize", () => win.webContents.send("win:state", false));
  if (process.env.SENTINEL_DEBUG) win.webContents.on("console-message", (e, lvl, msg) => console.log("[renderer]", msg !== undefined ? msg : (e && e.message) || ""));
  if (process.env.SENTINEL_SHOT) win.webContents.on("did-finish-load", () => setTimeout(async () => { try { const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.SENTINEL_SHOT, img.toPNG()); console.log("SHOT_SAVED"); } catch (e) { console.log("SHOT_ERR " + e.message); } }, 3500));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (!isWin && process.platform !== "darwin") app.quit(); else if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle("sysinfo", () => ({
  platform: process.platform, arch: process.arch, hostname: os.hostname(),
  release: os.release(), cpus: os.cpus().length,
  mem: Math.round(os.totalmem() / 1e9) + " GB", home: os.homedir(),
  electron: process.versions.electron, node: process.versions.node, version: app.getVersion(),
}));

// Check GitHub Releases for a newer version (renderer CSP blocks external fetch, so do it here).
ipcMain.handle("app:checkUpdate", async () => {
  const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
  try {
    const cur = app.getVersion();
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
    let r; try { r = await fetch("https://api.github.com/repos/SpartanKing18/sentinel-web/releases/tags/sentinel", { headers: { "User-Agent": "Sentinel" }, signal: ctrl.signal }); } finally { clearTimeout(to); }
    if (!r.ok) return { ok: false };
    const d = await r.json();
    const vers = (d.assets || []).map((a) => (a.name.match(/(\d+\.\d+\.\d+)/) || [])[1]).filter(Boolean).sort(cmp);
    const latest = vers.length ? vers[vers.length - 1] : cur;
    return { ok: true, current: cur, latest, update: cmp(latest, cur) > 0 };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Native Gmail OAuth (Desktop client: loopback + PKCE) ----
// A Desktop OAuth client can't keep its secret confidential (it ships in the app),
// which is expected for installed apps; loopback + PKCE is the flow Google prescribes.
// The id/secret are NOT hardcoded here — they load from env or oauth.config.json
// (gitignored), so no credentials live in source. See oauth.config.example.json.
function loadOAuthConfig() {
  try { const p = path.join(__dirname, "oauth.config.json"); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) {}
  return {};
}
const _oauthCfg = loadOAuthConfig();
const GMAIL_OAUTH = {
  clientId: process.env.SENTINEL_GMAIL_CLIENT_ID || _oauthCfg.gmailClientId || "",
  clientSecret: process.env.SENTINEL_GMAIL_CLIENT_SECRET || _oauthCfg.gmailClientSecret || "",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
};
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// Block loopback / link-local (incl. cloud metadata 169.254.169.254) / private
// ranges so net:get can't be turned into an SSRF/exfil channel by tool input.
function isPrivateHost(h) {
  h = String(h || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const mapped = h.match(/^::ffff:(.+)$/i);            // IPv4-mapped IPv6 -> check the v4 tail
  if (mapped) return isPrivateHost(mapped[1]);
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a > 255 || b > 255 || +m[3] > 255 || +m[4] > 255) return true; // malformed -> deny
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 169 && b === 254) return true;           // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // Not a dotted-quad literal: any non-canonical numeric encoding (decimal/hex/octal/
  // short-form) is only reachable after DNS resolution — the caller must also check the
  // RESOLVED address via resolvesToPrivate(). A bare integer host here is suspicious -> deny.
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  return false;
}
// Resolve a hostname and return true if ANY resolved address is private. Defeats
// public-name -> private-IP (DNS-rebind) and every non-canonical IPv4 encoding, since
// dns.lookup canonicalizes them. Fails closed (treat lookup failure as blocked).
async function resolvesToPrivate(host) {
  try {
    const addrs = await require("dns").promises.lookup(host, { all: true });
    return addrs.length === 0 || addrs.some((a) => isPrivateHost(a.address));
  } catch (_) { return true; }
}
async function gmailExchange(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  return r.json();
}
ipcMain.handle("gmail:oauth", async (_e, creds) => {
  const crypto = require("crypto");
  const clientId = (creds && creds.clientId) || GMAIL_OAUTH.clientId;
  const clientSecret = (creds && creds.clientSecret) || GMAIL_OAUTH.clientSecret;
  return await new Promise((resolve) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let redirect = "", done = false;
    const finish = (v) => { if (done) return; done = true; try { server.close(); } catch (_) {} resolve(v); };
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, redirect || "http://127.0.0.1");
        const code = u.searchParams.get("code"), err = u.searchParams.get("error");
        if (!code && !err) { res.writeHead(404); res.end(); return; }
        // CSRF defense-in-depth: reject callbacks whose state doesn't match ours.
        if (code && u.searchParams.get("state") !== state) { res.writeHead(400); res.end("bad state"); return; }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><meta charset=utf-8><body style='font-family:system-ui;background:#0b0e14;color:#e6edf3;text-align:center;padding-top:90px'><h2>" + (code ? "Gmail connected ✓" : "Gmail connection failed") + "</h2><p>You can close this tab and return to Sentinel.</p>");
        if (err || !code) return finish({ ok: false, error: err || "no authorization code" });
        const d = await gmailExchange({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect });
        if (d.access_token) finish({ ok: true, access_token: d.access_token, refresh_token: d.refresh_token || "", expires_in: d.expires_in || 3600 });
        else finish({ ok: false, error: d.error_description || d.error || "token exchange failed" });
      } catch (e) { finish({ ok: false, error: e.message }); }
    });
    server.on("error", (e) => finish({ ok: false, error: e.message }));
    server.listen(0, "127.0.0.1", () => {
      redirect = "http://127.0.0.1:" + server.address().port;
      const auth = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: GMAIL_OAUTH.scopes.join(" "), access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
      shell.openExternal(auth);
    });
    setTimeout(() => finish({ ok: false, error: "timed out waiting for Google sign-in" }), 300000);
  });
});
ipcMain.handle("gmail:refresh", async (_e, arg) => {
  const refreshToken = typeof arg === "string" ? arg : (arg && arg.refreshToken);
  if (!refreshToken) return { ok: false, error: "no refresh token" };
  const clientId = (arg && arg.clientId) || GMAIL_OAUTH.clientId;
  const clientSecret = (arg && arg.clientSecret) || GMAIL_OAUTH.clientSecret;
  try {
    const d = await gmailExchange({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
    if (d.access_token) return { ok: true, access_token: d.access_token, expires_in: d.expires_in || 3600 };
    return { ok: false, error: d.error_description || d.error || "refresh failed" };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Generic HTTP GET/POST proxy for the renderer — runs in the main process, so
// third-party security/OSINT APIs that don't send CORS headers still work.
// Returns { ok, status, data } (data is parsed JSON when the response is JSON).
ipcMain.handle("net:get", async (_e, opts) => {
  const { url, headers, method, body } = opts || {};
  try {
    if (!/^https?:\/\//i.test(String(url || ""))) return { ok: false, status: 0, error: "bad url" };
    let host = ""; try { host = new URL(url).hostname; } catch (_) { return { ok: false, status: 0, error: "bad url" }; }
    if (isPrivateHost(host) || await resolvesToPrivate(host)) return { ok: false, status: 0, error: "blocked host (loopback/link-local/private not allowed)" };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { method: method || "GET", headers: Object.assign({ "User-Agent": "Sentinel/1.0" }, headers || {}), body: body || undefined, signal: ctrl.signal });
      const ct = r.headers.get("content-type") || "";
      const data = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
      return { ok: r.ok, status: r.status, data };
    } finally { clearTimeout(to); }
  } catch (e) { return { ok: false, status: 0, error: e.name === "AbortError" ? "timed out" : e.message }; }
});

// Stream a shell command's output to the renderer.
ipcMain.handle("run", (_e, { id, cmd, cwd }) => {
  const p = isWin ? spawn("cmd.exe", ["/c", cmd], { cwd: cwd || os.homedir() })
                  : spawn("/bin/sh", ["-c", cmd], { cwd: cwd || os.homedir() });
  procs.set(id, p);
  const send = (chunk) => win && win.webContents.send("run:data", { id, chunk });
  p.stdout.on("data", (d) => send(d.toString()));
  p.stderr.on("data", (d) => send(d.toString()));
  p.on("close", (code) => { procs.delete(id); win && win.webContents.send("run:end", { id, code }); });
  p.on("error", (err) => { send("[error] " + err.message + "\n"); procs.delete(id); win && win.webContents.send("run:end", { id, code: -1 }); });
  return true;
});
ipcMain.handle("kill", (_e, id) => { const p = procs.get(id); if (p) { try { p.kill(); } catch (_) {} } return true; });

// ---- Agent: blocking command runner. Captures output + exit code (for the AI agent loop). ----
// Runs an agent command in a PTY so INTERACTIVE tools work fully autonomously:
// ssh, sudo, su, mysql -p, etc. all get a real terminal. We auto-answer the two prompts
// that otherwise block an unattended agent — the SSH host-key question ("yes") and
// password prompts (typed from the operator-configured `autopass`). Password input is not
// echoed by the tty, so it never lands in the captured output. Falls back to a plain pipe
// if node-pty is unavailable.
ipcMain.handle("agent:exec", (_e, { command, cwd, timeout, autopass }) => new Promise((res) => {
  const workdir = cwd || os.homedir();
  const cap = 50000;
  let out = "", killed = false, settled = false, answers = 0, to;
  const finish = (v) => { if (settled) return; settled = true; clearTimeout(to); res(v); };
  // Strip ANSI/OSC escapes + stray control chars so the model sees clean text.
  const clean = (s) => s
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[\[\]][0-9;?=]*[ -\/]*[@-~]/g, "")
    .replace(/\x1B[()][0-9A-Za-z]/g, "")
    .replace(/\x1B[=>NM]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, "\n");
  if (!isWin && nodePty) {
    let p;
    try { p = nodePty.spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols: 120, rows: 40, cwd: workdir, env: process.env }); }
    catch (err) { return finish({ ok: false, error: err.message }); }
    p.onData((d) => {
      if (out.length < cap + 8000) out += d;
      const tail = out.slice(-240);
      if (answers < 10) {
        if (/(?:\(yes\/no(?:\/\[fingerprint\])?\)\??|continue connecting\??)\s*$/i.test(tail)) { answers++; try { p.write("yes\r"); } catch (_) {} }
        else if (autopass && /(?:[Pp]assword|[Pp]assphrase)(?:\s+for\s+\S+)?:\s*$/.test(tail)) { answers++; try { p.write(autopass + "\r"); } catch (_) {} }
      }
    });
    p.onExit(({ exitCode }) => { let c = clean(out).trim(); if (autopass) c = c.split(autopass).join("***"); finish({ ok: true, code: exitCode, killed, output: c.length > cap ? c.slice(0, cap) + "\n...[truncated]" : (c || "(no output)") }); });
    to = setTimeout(() => { killed = true; try { p.kill(); } catch (_) {} }, timeout || 60000);
    return;
  }
  let p;
  try { p = isWin ? spawn("cmd.exe", ["/c", command], { cwd: workdir }) : spawn("/bin/sh", ["-c", command], { cwd: workdir }); }
  catch (err) { return finish({ ok: false, error: err.message }); }
  const add = (d) => { if (out.length < cap + 200) out += d.toString(); };
  p.stdout.on("data", add); p.stderr.on("data", add);
  p.on("close", (code) => { let c = out; if (autopass) c = c.split(autopass).join("***"); finish({ ok: true, code, killed, output: c.length > cap ? c.slice(0, cap) + "\n...[truncated]" : (c || "(no output)") }); });
  p.on("error", (err) => finish({ ok: false, error: err.message }));
  to = setTimeout(() => { killed = true; try { p.kill("SIGKILL"); } catch (_) {} }, timeout || 60000);
}));

// ---- Auto-configure a tool: install on first use, streaming progress. ----
// Privileged installs go through pkexec (graphical prompt); no password stored.
ipcMain.handle("tool:install", (_e, { id, install }) => new Promise((res) => {
  let cmd = String(install || "").trim();
  if (cmd.startsWith("sudo ")) cmd = "pkexec " + cmd.slice(5).replace(/^apt install/, "apt-get install");
  const p = spawn("/bin/bash", ["-lc", cmd]);
  const send = (c) => win && win.webContents.send("tool:install:data", { id, chunk: c.toString() });
  p.stdout.on("data", send); p.stderr.on("data", send);
  p.on("close", (code) => res({ ok: code === 0, code, cmd }));
  p.on("error", (e) => { send("[error] " + e.message + "\n"); res({ ok: false, error: e.message, cmd }); });
}));

// ---- interactive PTYs (real terminals, one per tab) ----
ipcMain.handle("pty:spawn", (_e, { cols, rows }) => {
  if (!nodePty) return { ok: false, error: "node-pty is not available in this build" };
  const id = "p" + (++ptySeq);
  const shell = isWin ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
  let p;
  try { p = nodePty.spawn(shell, [], { name: "xterm-color", cols: cols || 80, rows: rows || 24, cwd: os.homedir(), env: process.env }); }
  catch (e) { return { ok: false, error: e.message }; }
  ptys.set(id, p);
  p.onData((d) => win && win.webContents.send("pty:data", { id, data: d }));
  p.onExit(() => { ptys.delete(id); win && win.webContents.send("pty:exit", { id }); });
  return { ok: true, id, shell };
});
ipcMain.handle("pty:write", (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.handle("pty:resize", (_e, { id, cols, rows }) => { const p = ptys.get(id); if (p) { try { p.resize(cols, rows); } catch (_) {} } });
ipcMain.handle("pty:kill", (_e, { id }) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch (_) {} ptys.delete(id); } });

// Is a tool on PATH?
ipcMain.handle("which", (_e, name) => new Promise((res) => {
  const cmd = isWin ? "where " + name : "command -v " + name;
  const p = isWin ? spawn("cmd.exe", ["/c", cmd]) : spawn("/bin/sh", ["-c", cmd]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("close", (c) => res({ found: c === 0, path: out.trim() }));
  p.on("error", () => res({ found: false }));
}));

// Proxy local Ollama (avoids renderer file:// CORS).
ipcMain.handle("ollama", (_e, { path: pth, body }) => new Promise((res) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request(
    { host: "127.0.0.1", port: 11434, path: pth, method: data ? "POST" : "GET",
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
    (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res({ ok: true, data: JSON.parse(b) }); } catch (_) { res({ ok: true, data: b }); } }); }
  );
  req.on("error", (err) => res({ ok: false, error: err.message }));
  if (data) req.write(data);
  req.end();
}));

// Streaming Ollama chat: emits ollama:token events live, resolves with the full
// assembled message (content + tool_calls) when the stream ends.
const streamReqs = new Map();
ipcMain.handle("ollama:stream", (_e, { id, body }) => new Promise((resolve) => {
  const data = JSON.stringify(Object.assign({}, body, { stream: true }));
  let content = "", toolCalls = null, settled = false;
  const done = (v) => { if (settled) return; settled = true; streamReqs.delete(id); resolve(v); };
  const req = http.request(
    { host: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
    (r) => {
      let buf = "";
      r.on("data", (d) => {
        buf += d.toString(); let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
          let j; try { j = JSON.parse(line); } catch (_) { continue; }
          if (j.error) { done({ ok: false, error: j.error }); return; }
          const m = j.message || {};
          if (m.content) { content += m.content; win && win.webContents.send("ollama:token", { id, chunk: m.content }); }
          if (m.tool_calls && m.tool_calls.length) toolCalls = (toolCalls || []).concat(m.tool_calls);
        }
      });
      r.on("end", () => done({ ok: true, message: { role: "assistant", content, tool_calls: toolCalls || undefined } }));
      r.on("error", (err) => done({ ok: false, error: err.message }));
    }
  );
  req.on("error", (err) => done({ ok: false, error: err.message }));
  streamReqs.set(id, req);
  req.write(data); req.end();
}));
ipcMain.handle("ollama:cancel", (_e, id) => { const rq = streamReqs.get(id); if (rq) { try { rq.destroy(); } catch (_) {} streamReqs.delete(id); } return true; });

// ---- Claude (Anthropic) streaming — the cloud engine for the Assistant ----
// Mirrors ollama:stream's contract: streams claude:token events and resolves with
// { ok, message:{content}, usage:{inTok,outTok} }. Key comes from the request
// (Assistant settings) or the ANTHROPIC_API_KEY env var. For authorized security work.
const claudeReqs = new Map();
ipcMain.handle("claude:stream", (_e, { id, body, apiKey }) => new Promise((resolve) => {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || "";
  if (!key) { resolve({ ok: false, error: "no Anthropic API key — add one in the Assistant settings (gear) or set ANTHROPIC_API_KEY" }); return; }
  const data = JSON.stringify(Object.assign({}, toAnthropicBody(body), { stream: true }));
  let content = "", inTok = 0, outTok = 0, settled = false;
  const done = (v) => { if (settled) return; settled = true; claudeReqs.delete(id); resolve(v); };
  const req = https.request(
    { host: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-api-key": key, "anthropic-version": "2023-06-01" } },
    (r) => {
      if (r.statusCode >= 400) { let e = ""; r.on("data", (d) => (e += d)); r.on("end", () => { let msg = e; try { const j = JSON.parse(e); msg = (j.error && j.error.message) || e; } catch (_) {} done({ ok: false, error: "Anthropic " + r.statusCode + ": " + msg }); }); return; }
      let buf = "";
      r.on("data", (d) => {
        buf += d.toString(); let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim(); if (!p || p === "[DONE]") continue;
          let o; try { o = JSON.parse(p); } catch (_) { continue; }
          if (o.type === "error") { done({ ok: false, error: (o.error && o.error.message) || "stream error" }); return; }
          const txt = anthropicDelta(o); if (txt) { content += txt; win && win.webContents.send("claude:token", { id, chunk: txt }); }
          const u = usageOf(o); if (u) { if (u.inTok) inTok = u.inTok; if (u.outTok) outTok = u.outTok; }
        }
      });
      r.on("end", () => done({ ok: true, message: { role: "assistant", content }, usage: { inTok, outTok } }));
      r.on("error", (err) => done({ ok: false, error: err.message }));
    }
  );
  req.on("error", (err) => done({ ok: false, error: err.message }));
  claudeReqs.set(id, req);
  req.write(data); req.end();
}));
ipcMain.handle("claude:cancel", (_e, id) => { const rq = claudeReqs.get(id); if (rq) { try { rq.destroy(); } catch (_) {} claudeReqs.delete(id); } return true; });

// ---- Any model (OpenAI-compatible) streaming — OpenRouter, Groq, DeepSeek, Together,
// Mistral, LM Studio, vLLM, llama.cpp, … Mirrors ollama:stream's contract: emits
// api:token events, resolves with { ok, message:{content,tool_calls}, usage }. base +
// apiKey + model come from the Assistant settings. Tool-call args are parsed to objects
// so the planner sees the SAME shape Ollama returns.
const apiReqs = new Map();
function mergeToolCallDeltas(acc, deltas) {
  acc = acc || [];
  for (const d of deltas) {
    const i = typeof d.index === "number" ? d.index : acc.length;
    acc[i] = acc[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
    if (d.id) acc[i].id = d.id;
    if (d.type) acc[i].type = d.type;
    if (d.function) { if (d.function.name) acc[i].function.name = d.function.name; if (d.function.arguments) acc[i].function.arguments += d.function.arguments; }
  }
  return acc;
}
ipcMain.handle("api:stream", (_e, { id, body, base, apiKey, model }) => new Promise((resolve) => {
  let url;
  try { url = new URL(String(base || "").replace(/\/+$/, "") + "/chat/completions"); }
  catch (e) { resolve({ ok: false, error: "invalid API base URL: " + base }); return; }
  const lib = url.protocol === "https:" ? https : http;
  const payload = Object.assign({}, body, { stream: true }); if (model) payload.model = model;
  // translate Ollama-shaped fields to OpenAI schema: temperature lives at top level,
  // and format(JSON schema) → response_format so structured output is actually enforced.
  if (payload.options && typeof payload.options.temperature === "number") payload.temperature = payload.options.temperature;
  if (payload.format) payload.response_format = { type: "json_object" };
  delete payload.options; delete payload.format; delete payload.keep_alive; delete payload.num_ctx;
  const data = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) };
  const key = apiKey || process.env.SENTINEL_API_KEY || process.env.OPENAI_API_KEY || "";
  if (key) headers["Authorization"] = "Bearer " + key;
  let content = "", toolCalls = null, inTok = 0, outTok = 0, settled = false;
  const done = (v) => { if (settled) return; settled = true; apiReqs.delete(id); resolve(v); };
  const req = lib.request(
    { hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "POST", headers },
    (r) => {
      if (r.statusCode >= 400) { let e = ""; r.on("data", (d) => (e += d)); r.on("end", () => { let msg = e; try { const j = JSON.parse(e); msg = (j.error && j.error.message) || e; } catch (_) {} done({ ok: false, error: "API " + r.statusCode + ": " + String(msg).slice(0, 300) }); }); return; }
      let buf = "";
      r.on("data", (d) => {
        buf += d.toString(); let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim(); if (!p || p === "[DONE]") continue;
          let o; try { o = JSON.parse(p); } catch (_) { continue; }
          if (o.error) { done({ ok: false, error: (o.error && o.error.message) || "stream error" }); return; }
          const ch = (o.choices && o.choices[0]) || {}, delta = ch.delta || {};
          if (delta.content) { content += delta.content; win && win.webContents.send("api:token", { id, chunk: delta.content }); }
          if (delta.tool_calls && delta.tool_calls.length) toolCalls = mergeToolCallDeltas(toolCalls, delta.tool_calls);
          if (o.usage) { inTok = o.usage.prompt_tokens || inTok; outTok = o.usage.completion_tokens || outTok; }
        }
      });
      r.on("end", () => {
        const tc = toolCalls ? toolCalls.filter(Boolean).map((t) => ({ id: t.id, type: t.type, function: { name: t.function.name, arguments: (() => { try { return JSON.parse(t.function.arguments || "{}"); } catch (_) { return t.function.arguments; } })() } })) : null;
        done({ ok: true, message: { role: "assistant", content, tool_calls: tc && tc.length ? tc : undefined }, usage: { inTok, outTok } });
      });
      r.on("error", (err) => done({ ok: false, error: err.message }));
    }
  );
  req.on("error", (err) => done({ ok: false, error: err.message }));
  apiReqs.set(id, req);
  req.write(data); req.end();
}));
ipcMain.handle("api:cancel", (_e, id) => { const rq = apiReqs.get(id); if (rq) { try { rq.destroy(); } catch (_) {} apiReqs.delete(id); } return true; });

// ---- enterprise governance: usage ledger + signed compliance bundle ----
const govCwd = () => { try { return app.getPath("userData"); } catch (_) { return os.homedir(); } };
ipcMain.handle("gov:identity", () => { try { return resolveOperator({ cwd: govCwd() }); } catch (_) { return { operator: "unknown", team: "", source: "os" }; } });
ipcMain.handle("gov:usage:append", (_e, rec) => { try { return appendUsage(govCwd(), rec || {}); } catch (_) { return false; } });
ipcMain.handle("gov:usage:report", (_e, opts) => { try { const recs = loadUsage(govCwd(), (opts && opts.since) ? { since: opts.since } : {}); const s = summarize(recs); return { ok: true, summary: s, text: renderReport(s, { project: "Sentinel Assistant" }), count: recs.length }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });
ipcMain.handle("gov:compliance:build", (_e, opts) => {
  try {
    opts = opts || {}; const cwd = govCwd(); const id = resolveOperator({ cwd });
    const key = opts.signingKey || process.env.SENTINEL_SIGNING_KEY || "";
    const b = buildBundle(cwd, { operator: opts.operator || id.operator, team: opts.team || id.team, signingKey: key || undefined });
    let outPath = null;
    try { const dir = path.join(cwd, ".nexus"); fs.mkdirSync(dir, { recursive: true }); const stamp = new Date().toISOString().replace(/[:.]/g, "-"); outPath = path.join(dir, "compliance-" + stamp + ".json"); fs.writeFileSync(outPath, JSON.stringify(b, null, 2)); fs.writeFileSync(outPath.replace(/\.json$/, ".md"), renderBundleMd(b)); } catch (_) {}
    return { ok: true, bundle: b, md: renderBundleMd(b), path: outPath };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle("gov:compliance:verify", (_e, { bundle, signingKey }) => { try { return Object.assign({ ok: true }, verifyBundle(bundle, signingKey || process.env.SENTINEL_SIGNING_KEY || undefined)); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });

ipcMain.handle("openExternal", (_e, url) => {
  // Only open web URLs in the OS browser — never file://, or app/protocol-handler
  // schemes a browsed/redirected page could smuggle in.
  try { const p = new URL(String(url)).protocol; if (p === "http:" || p === "https:") return shell.openExternal(url); } catch (_) {}
  return false;
});

// ---- custom (frameless) window controls ----
ipcMain.handle("win:minimize", () => { if (win) win.minimize(); });
ipcMain.handle("win:maximize", () => { if (!win) return false; win.isMaximized() ? win.unmaximize() : win.maximize(); return win.isMaximized(); });
ipcMain.handle("win:close", () => { if (win) win.close(); });

// ---- CVE search (NVD) ----
ipcMain.handle("cve:search", async (_e, q) => {
  q = (q || "").trim(); if (!q) return { ok: false, error: "empty query" };
  const isId = /^CVE-\d{4}-\d+$/i.test(q);
  const url = "https://services.nvd.nist.gov/rest/json/cves/2.0?" + (isId ? "cveId=" + q.toUpperCase() : "keywordSearch=" + encodeURIComponent(q)) + "&resultsPerPage=20";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Sentinel" } });
    if (!r.ok) return { ok: false, error: r.status === 403 ? "NVD rate limit — wait a moment" : r.status + " " + r.statusText };
    const d = await r.json();
    const list = (d.vulnerabilities || []).map((v) => {
      const c = v.cve, desc = (c.descriptions.find((x) => x.lang === "en") || c.descriptions[0] || {}).value || "";
      const m = c.metrics || {}, p = m.cvssMetricV31 || m.cvssMetricV30 || m.cvssMetricV2;
      return { id: c.id, desc, score: p && p[0] ? p[0].cvssData.baseScore : "", sev: p && p[0] ? (p[0].cvssData.baseSeverity || p[0].baseSeverity || "") : "", published: (c.published || "").slice(0, 10) };
    });
    return { ok: true, total: d.totalResults, list };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- HTTP request tool (repeater). Runs in main to dodge renderer CSP/CORS. ----
ipcMain.handle("http:request", async (_e, { method, url, headers, body, timeout }) => {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout || 20000);
  try {
    const m = (method || "GET").toUpperCase();
    const res = await fetch(url, {
      method: m, headers: headers || {},
      body: (m === "GET" || m === "HEAD") ? undefined : (body || undefined),
      signal: ctrl.signal, redirect: "follow",
    });
    const text = await res.text();
    const hdrs = {}; res.headers.forEach((v, k) => (hdrs[k] = v));
    return { ok: true, status: res.status, statusText: res.statusText, url: res.url, headers: hdrs, body: text.length > 200000 ? text.slice(0, 200000) + "\n...[truncated]" : text, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: e.name === "AbortError" ? "request timed out" : e.message, ms: Date.now() - t0 }; }
  finally { clearTimeout(to); }
});

// ---- Loot: browse saved command output under ~/sentinel-results ----
ipcMain.handle("results:list", async () => {
  try {
    const names = await fs.promises.readdir(RESULTS_DIR);
    const items = [];
    for (const n of names) {
      try { const st = await fs.promises.stat(path.join(RESULTS_DIR, n)); if (st.isFile()) items.push({ name: n, size: st.size, mtime: st.mtimeMs }); } catch (_) {}
    }
    items.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, dir: RESULTS_DIR, items };
  } catch (e) { return { ok: false, error: e.message, dir: RESULTS_DIR, items: [] }; }
});
ipcMain.handle("results:read", async (_e, name) => {
  try {
    if (!name || name.includes("/") || name.includes("..")) return { ok: false, error: "invalid file name" };
    const data = await fs.promises.readFile(path.join(RESULTS_DIR, name), "utf8");
    return { ok: true, name, data: data.length > 500000 ? data.slice(-500000) : data };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("results:reveal", () => shell.openPath(RESULTS_DIR));

// ---- Built-in TCP port scanner (native, no external tools). Streams hits live. ----
const scans = new Map();
ipcMain.handle("scan:cancel", (_e, id) => { const s = scans.get(id); if (s) s.cancelled = true; return true; });
ipcMain.handle("scan:ports", async (_e, { id, host, ports, timeout, concurrency }) => {
  const state = { cancelled: false };
  scans.set(id, state);
  const to = timeout || 900, conc = Math.min(concurrency || 250, 500), total = ports.length;
  let idx = 0, open = 0;
  const probe = (port) => new Promise((res) => {
    const sock = new net.Socket(); let done = false, banner = "";
    const finish = (isOpen) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {}
      if (isOpen) { open++; win && win.webContents.send("scan:hit", { id, port, banner: banner.slice(0, 80) }); } res(); };
    sock.setTimeout(to);
    sock.once("connect", () => { sock.once("data", (d) => { banner = d.toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim(); finish(true); }); setTimeout(() => finish(true), 150); });
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  });
  const worker = async () => {
    while (!state.cancelled) {
      const i = idx++; if (i >= total) return;
      await probe(ports[i]);
      if (win) win.webContents.send("scan:progress", { id, done: i + 1, total });
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
  scans.delete(id);
  win && win.webContents.send("scan:done", { id, open, cancelled: state.cancelled });
  return { ok: true };
});

// ---- directory / content fuzzer (native, streams hits) ----
function headReq(url, to) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch (_) { return res(null); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method: "GET", timeout: to || 8000, rejectUnauthorized: false, headers: { "User-Agent": "Sentinel" } }, (r) => {
      const out = { status: r.statusCode, len: r.headers["content-length"] || "", loc: r.headers["location"] || "" };
      r.destroy(); res(out);
    });
    req.on("timeout", () => { req.destroy(); res(null); });
    req.on("error", () => res(null));
    req.end();
  });
}
const fuzzes = new Map();
ipcMain.handle("fuzz:cancel", (_e, id) => { const s = fuzzes.get(id); if (s) s.cancelled = true; return true; });
ipcMain.handle("fuzz:dirs", async (_e, { id, base, words, concurrency, timeout }) => {
  const state = { cancelled: false }; fuzzes.set(id, state);
  base = base.replace(/\/+$/, ""); const to = timeout || 8000, conc = Math.min(concurrency || 25, 50), total = words.length;
  let idx = 0, hits = 0;
  const probe = async (word) => {
    const r = await headReq(base + "/" + word.replace(/^\//, ""), to);
    if (r && r.status && r.status !== 404) { hits++; win && win.webContents.send("fuzz:hit", { id, path: "/" + word.replace(/^\//, ""), status: r.status, len: r.len, loc: r.loc }); }
  };
  const worker = async () => { while (!state.cancelled) { const i = idx++; if (i >= total) return; await probe(words[i]); if (win) win.webContents.send("fuzz:progress", { id, done: i + 1, total }); } };
  await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
  fuzzes.delete(id); win && win.webContents.send("fuzz:done", { id, hits, cancelled: state.cancelled });
  return { ok: true };
});

// ---- DNS lookups (native resolver) ----
ipcMain.handle("dns:lookup", async (_e, host) => {
  host = (host || "").trim().replace(/^https?:\/\//, "").split("/")[0];
  if (!host) return { ok: false, error: "no host" };
  const rec = {};
  const kinds = [["A", "resolve4"], ["AAAA", "resolve6"], ["MX", "resolveMx"], ["NS", "resolveNs"], ["TXT", "resolveTxt"], ["CNAME", "resolveCname"], ["SOA", "resolveSoa"]];
  for (const [label, fn] of kinds) { try { rec[label] = await dns[fn](host); } catch (_) { rec[label] = null; } }
  try { if (rec.A && rec.A.length) rec.PTR = await dns.reverse(rec.A[0]).catch(() => null); } catch (_) {}
  return { ok: true, host, rec };
});

// ---- WHOIS (native, follows the IANA referral) ----
function whoisAsk(server, query) {
  return new Promise((res) => {
    const s = net.connect(43, server); let data = "";
    s.setTimeout(9000);
    s.on("connect", () => s.write(query + "\r\n"));
    s.on("data", (d) => (data += d.toString("utf8")));
    s.on("end", () => res(data));
    s.on("timeout", () => { try { s.destroy(); } catch (_) {} res(data); });
    s.on("error", () => res(data));
  });
}
ipcMain.handle("whois:query", async (_e, query) => {
  query = (query || "").trim().replace(/^https?:\/\//, "").split("/")[0];
  if (!query) return { ok: false, error: "no query" };
  try {
    let txt = await whoisAsk("whois.iana.org", query);
    const refer = (txt.match(/refer:\s*(\S+)/i) || [])[1] || (txt.match(/whois:\s*(\S+)/i) || [])[1];
    if (refer) { const more = await whoisAsk(refer, query); if (more && more.trim()) txt = more; }
    return { ok: true, query, text: txt.trim() || "no data" };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- TLS / certificate inspector ----
ipcMain.handle("tls:cert", async (_e, { host, port }) => {
  host = (host || "").trim().replace(/^https?:\/\//, "").split("/")[0];
  port = port || 443;
  return new Promise((res) => {
    let done = false; const finish = (v) => { if (done) return; done = true; res(v); };
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 9000 }, () => {
      const c = s.getPeerCertificate(false);
      const flat = (o) => Object.entries(o || {}).map(([k, v]) => k + "=" + v).join(", ");
      finish({ ok: true, cert: {
        subject: flat(c.subject), issuer: flat(c.issuer), valid_from: c.valid_from, valid_to: c.valid_to,
        san: (c.subjectaltname || "").replace(/DNS:/g, ""), fingerprint256: c.fingerprint256, serial: c.serialNumber,
        bits: c.bits || "", protocol: s.getProtocol(), cipher: (s.getCipher() || {}).name,
        daysLeft: c.valid_to ? Math.round((new Date(c.valid_to) - Date.now()) / 86400000) : null,
      } });
      s.end();
    });
    s.on("error", (e) => finish({ ok: false, error: e.message }));
    s.on("timeout", () => { try { s.destroy(); } catch (_) {} finish({ ok: false, error: "connection timed out" }); });
  });
});

// ---- GitHub integration: clone / status / commit & push ----
const REPOS_DIR = path.join(os.homedir(), "sentinel-repos");
function git(args, opts) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 1e7, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}
const authUrl = (url, token) => (token && /^https:\/\//i.test(url)) ? url.replace(/^https:\/\//i, "https://" + token + "@") : url;
const scrub = (s, token) => String(s || "").split(token || "__none__").join("***").slice(0, 400);

ipcMain.handle("git:clone", async (_e, { url, token }) => {
  url = (url || "").trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, error: "use an https repo URL (https://github.com/owner/repo)" };
  try {
    await fs.promises.mkdir(REPOS_DIR, { recursive: true });
    const name = (url.split("/").pop() || "repo").replace(/\.git$/, "");
    const dir = path.join(REPOS_DIR, name);
    try { await fs.promises.access(dir); return { ok: false, error: "folder already exists — open it instead: " + dir }; } catch (_) {}
    await git(["clone", authUrl(url, token), dir]);
    try { await git(["-C", dir, "remote", "set-url", "origin", url]); } catch (_) {} // scrub token from stored remote
    return { ok: true, dir, name };
  } catch (e) { return { ok: false, error: scrub(e.stderr || e.message, token) }; }
});
ipcMain.handle("git:pull", async (_e, { dir, token }) => {
  try {
    const remote = (await git(["-C", dir, "remote", "get-url", "origin"])).stdout.trim();
    const r = await git(["-C", dir, "pull", authUrl(remote, token)]);
    return { ok: true, output: scrub(r.stdout || r.stderr || "up to date", token) };
  } catch (e) { return { ok: false, error: scrub(e.stderr || e.message, token) }; }
});
ipcMain.handle("git:log", async (_e, dir) => {
  try { const r = await git(["-C", dir, "log", "--oneline", "-40", "--no-color"]); return { ok: true, commits: r.stdout.trim().split("\n").filter(Boolean) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("git:diff", async (_e, { dir, file }) => {
  try { const r = await git(["-C", dir, "diff", "--no-color"].concat(file ? ["--", file] : [])); return { ok: true, diff: r.stdout || "(no working-tree changes)" }; }
  catch (e) { return { ok: false, error: e.message }; }
});
async function repoFromDir(dir) {
  try { const remote = (await git(["-C", dir, "remote", "get-url", "origin"])).stdout.trim(); const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i); return m && m[1]; } catch (_) { return null; }
}
async function ghPost(repo, path, token, body) {
  const r = await fetch("https://api.github.com/repos/" + repo + path, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "Sentinel" }, body: JSON.stringify(body) });
  if (!r.ok) { let m = r.status + " " + r.statusText; try { const j = await r.json(); if (j.message) m = j.message; } catch (_) {} throw new Error(m); }
  return r.json();
}
ipcMain.handle("github:createIssue", async (_e, { dir, token, title, body }) => {
  const repo = await repoFromDir(dir);
  if (!repo) return { ok: false, error: "no GitHub remote" };
  if (!token) return { ok: false, error: "set a GitHub token in Settings" };
  try { const d = await ghPost(repo, "/issues", token, { title, body: body || "" }); return { ok: true, number: d.number, url: d.html_url }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("github:createPR", async (_e, { dir, token, title, body }) => {
  const repo = await repoFromDir(dir);
  if (!repo) return { ok: false, error: "no GitHub remote" };
  if (!token) return { ok: false, error: "set a GitHub token in Settings" };
  try {
    const head = (await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const info = await fetch("https://api.github.com/repos/" + repo, { headers: { Authorization: "Bearer " + token, "User-Agent": "Sentinel" } }).then((r) => r.json());
    const base = info.default_branch || "main";
    if (head === base) return { ok: false, error: "you're on the base branch (" + base + ") — create a branch first" };
    const d = await ghPost(repo, "/pulls", token, { title, head, base, body: body || "" });
    return { ok: true, number: d.number, url: d.html_url };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("github:createGist", async (_e, { token, name, content, description, isPublic }) => {
  if (!token) return { ok: false, error: "set a GitHub token in Settings" };
  try {
    const r = await fetch("https://api.github.com/gists", { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "Sentinel" }, body: JSON.stringify({ description: description || "", public: !!isPublic, files: { [name || "file.txt"]: { content: content || " " } } }) });
    if (!r.ok) return { ok: false, error: r.status + " " + r.statusText };
    const d = await r.json(); return { ok: true, url: d.html_url };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("github:comment", async (_e, { dir, token, number, body }) => {
  const repo = await repoFromDir(dir);
  if (!repo) return { ok: false, error: "no GitHub remote" };
  if (!token) return { ok: false, error: "set a GitHub token in Settings" };
  try { const d = await ghPost(repo, "/issues/" + number + "/comments", token, { body }); return { ok: true, url: d.html_url }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("git:branches", async (_e, dir) => {
  try {
    const cur = (await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const b = await git(["-C", dir, "branch", "--format=%(refname:short)"]);
    return { ok: true, current: cur, branches: b.stdout.trim().split("\n").filter(Boolean) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("git:checkout", async (_e, { dir, branch }) => {
  try { await git(["-C", dir, "checkout", branch]); return { ok: true }; }
  catch (e) { return { ok: false, error: scrub(e.stderr || e.message) }; }
});
ipcMain.handle("git:checkoutNew", async (_e, { dir, branch }) => {
  try { await git(["-C", dir, "checkout", "-b", branch]); return { ok: true }; }
  catch (e) { return { ok: false, error: scrub(e.stderr || e.message) }; }
});
ipcMain.handle("github:issues", async (_e, { dir, token }) => {
  let repo;
  try { const remote = (await git(["-C", dir, "remote", "get-url", "origin"])).stdout.trim(); const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i); repo = m && m[1]; } catch (_) {}
  if (!repo) return { ok: false, error: "no GitHub remote" };
  const h = { Accept: "application/vnd.github+json", "User-Agent": "Sentinel" }; if (token) h.Authorization = "Bearer " + token;
  try {
    const [iss, prs] = await Promise.all([
      fetch("https://api.github.com/repos/" + repo + "/issues?state=open&per_page=25", { headers: h }).then((r) => r.ok ? r.json() : []),
      fetch("https://api.github.com/repos/" + repo + "/pulls?state=open&per_page=25", { headers: h }).then((r) => r.ok ? r.json() : []),
    ]);
    return { ok: true, repo, issues: iss.filter((x) => !x.pull_request).map((x) => ({ n: x.number, t: x.title, u: x.user && x.user.login, url: x.html_url })), prs: prs.map((x) => ({ n: x.number, t: x.title, u: x.user && x.user.login, url: x.html_url })) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("github:repos", async (_e, token) => {
  if (!token) return { ok: false, error: "no token set" };
  try {
    const r = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", { headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token } });
    if (!r.ok) return { ok: false, error: r.status === 401 ? "bad token" : r.status + " " + r.statusText };
    const data = await r.json();
    return { ok: true, repos: data.map((x) => ({ name: x.full_name, url: x.clone_url, priv: x.private })) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("git:status", async (_e, dir) => {
  try {
    const b = await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ({ stdout: "" }));
    const st = await git(["-C", dir, "status", "--porcelain"]);
    return { ok: true, branch: b.stdout.trim(), files: st.stdout.trim().split("\n").filter(Boolean) };
  } catch (e) { return { ok: false, error: "not a git repository" }; }
});
ipcMain.handle("git:push", async (_e, { dir, message, token, name, email }) => {
  try {
    await git(["-C", dir, "add", "-A"]);
    try {
      await git(["-C", dir, "-c", "user.name=" + (name || "Sentinel"), "-c", "user.email=" + (email || "sentinel@local"), "commit", "-m", message || "Update via Sentinel"]);
    } catch (e) { if (!/nothing to commit/i.test((e.stdout || "") + (e.stderr || ""))) throw e; }
    const remote = (await git(["-C", dir, "remote", "get-url", "origin"])).stdout.trim();
    const branch = (await git(["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const r = await git(["-C", dir, "push", authUrl(remote, token), "HEAD:" + branch]);
    return { ok: true, output: scrub(r.stderr || r.stdout || "pushed", token) };
  } catch (e) { return { ok: false, error: scrub(e.stderr || e.message, token) }; }
});

// ---- passive subdomain enumeration (Certificate Transparency via crt.sh) ----
ipcMain.handle("subdomains:find", async (_e, domain) => {
  domain = (domain || "").trim().replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  if (!domain) return { ok: false, error: "no domain" };
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch("https://crt.sh/?q=%25." + encodeURIComponent(domain) + "&output=json", { signal: ctrl.signal, headers: { "User-Agent": "Sentinel" } });
    const txt = await r.text(); let data;
    try { data = JSON.parse(txt); } catch { return { ok: false, error: "crt.sh is busy — try again in a moment" }; }
    const set = new Set();
    for (const e of data) for (const n of String(e.name_value || "").split("\n")) {
      const s = n.trim().toLowerCase();
      if (s && !s.includes("*") && (s === domain || s.endsWith("." + domain))) set.add(s);
    }
    return { ok: true, domain, subs: [...set].sort() };
  } catch (e) { return { ok: false, error: e.name === "AbortError" ? "crt.sh timed out" : e.message }; }
  finally { clearTimeout(to); }
});

// ---- Workbench filesystem (IDE). Full local FS access — this is a local dev tool. ----
const IGNORE = new Set([".git", "node_modules", ".cache", "__pycache__", ".venv", "dist", ".next"]);
ipcMain.handle("dialog:openFolder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle("dialog:openFile", async (_e, filters) => {
  const r = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: filters || [] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle("fs:list", async (_e, dir) => {
  const target = dir || os.homedir();
  try {
    const ents = await fs.promises.readdir(target, { withFileTypes: true });
    const items = ents
      .filter((d) => !(d.isDirectory() && IGNORE.has(d.name)))
      .map((d) => ({ name: d.name, dir: d.isDirectory(), path: path.join(target, d.name) }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, path: target, parent: path.dirname(target), items };
  } catch (e) { return { ok: false, error: e.message, path: target }; }
});
ipcMain.handle("fs:read", async (_e, file) => {
  try {
    const st = await fs.promises.stat(file);
    if (st.size > 5e6) return { ok: false, error: "file too large (" + Math.round(st.size / 1e6) + " MB)" };
    return { ok: true, path: file, data: await fs.promises.readFile(file, "utf8") };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("fs:write", async (_e, { file, data }) => {
  try { await fs.promises.writeFile(file, data, "utf8"); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("fs:mkfile", async (_e, { dir, name }) => {
  try { const full = path.join(dir, name); await fs.promises.writeFile(full, "", { flag: "wx" }); return { ok: true, path: full }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
//  QEMU/KVM VM engine — Sentinel's own virtual-machine manager.
//  Owns a VM store, creates qcow2 disks, boots via qemu-system-x86_64
//  with KVM acceleration, controls VMs live over QMP, and serves the
//  screen to the renderer via periodic screendumps.
// ============================================================
const VM_DIR = path.join(os.homedir(), ".sentinel-vms");
const VM_STORE = path.join(VM_DIR, "vms.json");
const VM_DISKS = path.join(VM_DIR, "disks");
const VM_RUN = path.join(VM_DIR, "run");
const vmProcs = new Map(); // id -> { proc, display, vncPort, qmp }
const QEMU = "qemu-system-x86_64";

function vmEnsureDirs() { for (const d of [VM_DIR, VM_DISKS, VM_RUN]) fs.mkdirSync(d, { recursive: true }); }
function vmReadStore() { try { return JSON.parse(fs.readFileSync(VM_STORE, "utf8")).vms || []; } catch (_) { return []; } }
function vmWriteStore(vms) { vmEnsureDirs(); fs.writeFileSync(VM_STORE, JSON.stringify({ vms }, null, 2)); }
function vmHasKvm() { try { fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK); return true; } catch (_) { return false; } }
function vmExec(cmd, args, timeout) {
  return new Promise((res) => {
    const p = spawn(cmd, args); let out = "", err = "";
    const to = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) {} }, timeout || 30000);
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(to); res({ code, out, err }); });
    p.on("error", (e) => { clearTimeout(to); res({ code: -1, err: e.message }); });
  });
}
// Streaming variant: pipe live output to the VM build log in the renderer.
function vmBuildLog(s) { try { win && win.webContents.send("vm:buildLog", s); } catch (_) {} }
function vmExecStream(cmd, args, timeout, opts) {
  return new Promise((res) => {
    const p = spawn(cmd, args, opts || {}); let out = "", err = "";
    const to = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) {} }, timeout || 60000);
    p.stdout.on("data", (d) => { out += d; vmBuildLog(d.toString()); });
    p.stderr.on("data", (d) => { err += d; vmBuildLog(d.toString()); });
    p.on("close", (code) => { clearTimeout(to); res({ code, out, err }); });
    p.on("error", (e) => { clearTimeout(to); res({ code: -1, err: e.message }); });
  });
}
const SENTINEL_OS_REPO = "https://github.com/SpartanKing18/sentinel-os";
const SENTINEL_OS_BASES = { debian: 1, ubuntu: 1, ubuntu22: 1, kali: 1 };

// Minimal QMP client: connect, negotiate capabilities, run one command, resolve.
function qmp(sockPath, command, args, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect(sockPath);
    let buf = "", phase = "greet", settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(to); try { s.end(); } catch (_) {} resolve(v); };
    const to = setTimeout(() => done({ error: "qmp timeout" }), timeoutMs || 8000);
    s.on("error", (e) => done({ error: e.message }));
    s.on("data", (d) => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
        let j; try { j = JSON.parse(line); } catch (_) { continue; }
        if (j.QMP && phase === "greet") { phase = "caps"; s.write(JSON.stringify({ execute: "qmp_capabilities" }) + "\n"); continue; }
        if (phase === "caps" && (j.return !== undefined || j.error)) { phase = "cmd"; s.write(JSON.stringify({ execute: command, arguments: args || {} }) + "\n"); continue; }
        if (phase === "cmd" && (j.return !== undefined || j.error)) { done(j.error ? { error: j.error.desc || "qmp error" } : { ok: true, data: j.return }); return; }
      }
    });
  });
}

ipcMain.handle("vm:deps", async () => {
  const q = await vmExec("bash", ["-lc", "command -v " + QEMU + " && command -v qemu-img"], 8000);
  return { qemu: q.code === 0, kvm: vmHasKvm(), qemuPath: (q.out || "").trim().split("\n")[0] || "" };
});
ipcMain.handle("vm:list", () => {
  const vms = vmReadStore();
  return vms.map((v) => ({ ...v, running: vmProcs.has(v.id), vncPort: vmProcs.get(v.id) ? vmProcs.get(v.id).vncPort : null }));
});
ipcMain.handle("vm:create", async (_e, { name, memMB, cpus, diskGB, iso }) => {
  vmEnsureDirs();
  name = (name || "vm").replace(/[^\w.-]/g, "_").slice(0, 40) || "vm";
  const id = "vm" + Date.now().toString(36);
  const disk = path.join(VM_DISKS, id + ".qcow2");
  const r = await vmExec("qemu-img", ["create", "-f", "qcow2", disk, Math.max(1, Math.min(512, parseInt(diskGB, 10) || 20)) + "G"], 30000);
  if (r.code !== 0) return { ok: false, error: (r.err || "qemu-img failed").trim() };
  const vms = vmReadStore();
  const vm = { id, name, memMB: Math.max(256, Math.min(65536, parseInt(memMB, 10) || 2048)), cpus: Math.max(1, Math.min(32, parseInt(cpus, 10) || 2)), disk, iso: iso || "", created: Date.now() };
  vms.push(vm); vmWriteStore(vms);
  return { ok: true, vm };
});
// Build a Sentinel OS VM on a chosen base OS: reuse the tested sentinel-os build.sh
// (downloads the base cloud image + builds the cloud-init seed), then register the VM.
// The disk self-provisions the Sentinel desktop + toolset on first boot.
ipcMain.handle("vm:buildSentinel", async (_e, { name, os: baseOS, memMB, cpus, diskGB }) => {
  vmEnsureDirs();
  if (!SENTINEL_OS_BASES[baseOS]) return { ok: false, error: "unknown base OS '" + baseOS + "'" };
  const dep = await vmExec("bash", ["-lc", "command -v git >/dev/null && command -v qemu-img >/dev/null && { command -v xorriso >/dev/null || command -v genisoimage >/dev/null || command -v cloud-localds >/dev/null; }"], 8000);
  if (dep.code !== 0) return { ok: false, error: "Missing build tools. Install them: sudo apt install git qemu-utils xorriso" };
  const SRC = path.join(VM_DIR, "sentinel-os-src");
  if (!fs.existsSync(path.join(SRC, "build.sh"))) {
    vmBuildLog("Cloning the Sentinel OS build recipe…\n");
    const c = await vmExecStream("git", ["clone", "--depth", "1", SENTINEL_OS_REPO + ".git", SRC], 300000);
    if (c.code !== 0) return { ok: false, error: "git clone failed: " + (c.err || "").slice(0, 300) };
  } else {
    vmBuildLog("Updating the Sentinel OS build recipe…\n");
    await vmExecStream("git", ["-C", SRC, "pull", "--ff-only"], 60000);
  }
  vmBuildLog("\nBuilding the " + baseOS + " base image + cloud-init seed (downloads a few hundred MB)…\n");
  const b = await vmExecStream("bash", ["-lc", 'cd "' + SRC + '" && rm -f sentinel-os.qcow2 seed.iso && SENTINEL_BASE=' + baseOS + " ./build.sh " + baseOS], 1800000);
  const builtDisk = path.join(SRC, "sentinel-os.qcow2"), builtSeed = path.join(SRC, "seed.iso");
  if (b.code !== 0 || !fs.existsSync(builtDisk)) return { ok: false, error: "build failed: " + (b.err || b.out || "no disk produced").slice(-300) };
  name = (name || ("sentinel-" + baseOS)).replace(/[^\w.-]/g, "_").slice(0, 40) || ("sentinel-" + baseOS);
  const id = "vm" + Date.now().toString(36);
  const disk = path.join(VM_DISKS, id + ".qcow2"), seed = path.join(VM_DISKS, id + "-seed.iso");
  try { fs.renameSync(builtDisk, disk); } catch (_) { fs.copyFileSync(builtDisk, disk); fs.unlinkSync(builtDisk); }
  if (fs.existsSync(builtSeed)) { try { fs.renameSync(builtSeed, seed); } catch (_) { fs.copyFileSync(builtSeed, seed); } }
  await vmExec("qemu-img", ["resize", disk, Math.max(20, Math.min(512, parseInt(diskGB, 10) || 30)) + "G"], 30000);
  const vms = vmReadStore();
  const vm = { id, name, memMB: Math.max(1024, Math.min(65536, parseInt(memMB, 10) || 4096)), cpus: Math.max(1, Math.min(32, parseInt(cpus, 10) || 2)), disk, seed: fs.existsSync(seed) ? seed : "", iso: "", os: baseOS, sentinel: true, created: Date.now() };
  vms.push(vm); vmWriteStore(vms);
  vmBuildLog("\n✓ Built '" + name + "'. Start it to self-provision on first boot.\n");
  return { ok: true, vm };
});
ipcMain.handle("vm:update", (_e, { id, patch }) => {
  const vms = vmReadStore(); const v = vms.find((x) => x.id === id); if (!v) return { ok: false, error: "no such vm" };
  Object.assign(v, patch || {}); vmWriteStore(vms); return { ok: true, vm: v };
});
ipcMain.handle("vm:delete", async (_e, { id, deleteDisk }) => {
  if (vmProcs.has(id)) { try { vmProcs.get(id).proc.kill("SIGKILL"); } catch (_) {} vmProcs.delete(id); }
  const vms = vmReadStore(); const v = vms.find((x) => x.id === id);
  if (v && deleteDisk) { try { fs.unlinkSync(v.disk); } catch (_) {} }
  vmWriteStore(vms.filter((x) => x.id !== id)); return { ok: true };
});
ipcMain.handle("vm:start", async (_e, { id }) => {
  if (vmProcs.has(id)) return { ok: true, already: true, vncPort: vmProcs.get(id).vncPort };
  const vms = vmReadStore(); const v = vms.find((x) => x.id === id); if (!v) return { ok: false, error: "no such vm" };
  vmEnsureDirs();
  const used = new Set([...vmProcs.values()].map((r) => r.display));
  let display = 0; while (used.has(display) && display < 64) display++;
  const qmpPath = path.join(VM_RUN, id + ".qmp");
  try { fs.unlinkSync(qmpPath); } catch (_) {}
  const args = ["-name", v.name, "-m", String(v.memMB), "-smp", String(v.cpus),
    "-drive", "file=" + v.disk + ",format=qcow2,if=virtio",
    "-vnc", "127.0.0.1:" + display,
    "-qmp", "unix:" + qmpPath + ",server,nowait",
    "-usb", "-device", "usb-tablet",
    "-netdev", "user,id=n0", "-device", "virtio-net,netdev=n0"];
  if (vmHasKvm()) args.unshift("-enable-kvm", "-cpu", "host");
  if (v.iso) { args.push("-cdrom", v.iso, "-boot", "menu=on,order=dc"); }
  // Sentinel OS: attach the cloud-init NoCloud seed (volume CIDATA) so first boot self-provisions
  if (v.seed && fs.existsSync(v.seed)) { args.push("-drive", "file=" + v.seed + ",media=cdrom,format=raw"); }
  let proc;
  try { proc = spawn(QEMU, args, { stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return { ok: false, error: e.message }; }
  let earlyErr = "";
  proc.stderr.on("data", (d) => (earlyErr += d.toString()));
  proc.on("exit", () => { vmProcs.delete(id); win && win.webContents.send("vm:exit", { id }); });
  const rec = { proc, display, vncPort: 5900 + display, qmp: qmpPath };
  vmProcs.set(id, rec);
  // give QEMU a moment; if it died immediately, report the error
  await new Promise((r) => setTimeout(r, 700));
  if (proc.exitCode !== null) {
    vmProcs.delete(id);
    let err = (earlyErr || "QEMU exited on launch").trim();
    if (/Failed to get "?write"? lock|Is another process using the image/i.test(err)) err = "This VM's disk is already in use by another running instance. Stop that one first, or reboot to clear a stale lock.";
    else if (/Could not access KVM|Permission denied.*kvm|\/dev\/kvm/i.test(err)) err = "Can't access /dev/kvm. Add yourself to the 'kvm' group (sudo usermod -aG kvm $USER) and log out/in.";
    return { ok: false, error: err.slice(0, 400) };
  }
  return { ok: true, vncPort: rec.vncPort, display };
});
ipcMain.handle("vm:stop", async (_e, { id, force }) => {
  const r = vmProcs.get(id); if (!r) return { ok: true, note: "not running" };
  if (force) { try { r.proc.kill("SIGKILL"); } catch (_) {} vmProcs.delete(id); return { ok: true }; }
  const res = await qmp(r.qmp, "system_powerdown", {}, 5000);
  if (res.error) { try { r.proc.kill("SIGTERM"); } catch (_) {} }
  return { ok: true };
});
ipcMain.handle("vm:reset", async (_e, { id }) => { const r = vmProcs.get(id); if (!r) return { ok: false }; return await qmp(r.qmp, "system_reset", {}, 5000); });
ipcMain.handle("vm:key", async (_e, { id, keys }) => {
  const r = vmProcs.get(id); if (!r) return { ok: false, error: "not running" };
  const arr = (keys || []).map((k) => ({ type: "qcode", data: k }));
  return await qmp(r.qmp, "send-key", { keys: arr }, 5000);
});
ipcMain.handle("vm:mouse", async (_e, { id, x, y, down, up }) => {
  const r = vmProcs.get(id); if (!r) return { ok: false, error: "not running" };
  const events = [
    { type: "abs", data: { axis: "x", value: Math.max(0, Math.min(32767, Math.round((x || 0) * 32767))) } },
    { type: "abs", data: { axis: "y", value: Math.max(0, Math.min(32767, Math.round((y || 0) * 32767))) } },
  ];
  if (down) events.push({ type: "btn", data: { button: "left", down: true } });
  if (up) events.push({ type: "btn", data: { button: "left", down: false } });
  return await qmp(r.qmp, "input-send-event", { events }, 5000);
});
ipcMain.handle("vm:screendump", async (_e, { id }) => {
  const r = vmProcs.get(id); if (!r) return { ok: false, error: "not running" };
  const png = path.join(VM_RUN, id + ".png");
  const res = await qmp(r.qmp, "screendump", { filename: png, format: "png" }, 6000);
  if (res.error) {
    const ppm = path.join(VM_RUN, id + ".ppm");
    const r2 = await qmp(r.qmp, "screendump", { filename: ppm }, 6000);
    if (r2.error) return { ok: false, error: r2.error };
    try {
      const buf = fs.readFileSync(ppm);
      // parse P6 PPM: "P6\n<w> <h>\n255\n<rgb bytes>"
      const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d;
      let p = 0; const tok = () => { while (p < buf.length && isWs(buf[p])) p++; let s = p; while (p < buf.length && !isWs(buf[p])) p++; return buf.slice(s, p).toString(); };
      if (tok() !== "P6") return { ok: false, error: "bad ppm" };
      const w = +tok(), h = +tok(); tok(); p++; // skip maxval + single whitespace
      const rgb = buf.slice(p); const bgra = Buffer.alloc(w * h * 4);
      for (let i = 0, j = 0; i < w * h; i++) { bgra[j] = rgb[i * 3 + 2]; bgra[j + 1] = rgb[i * 3 + 1]; bgra[j + 2] = rgb[i * 3]; bgra[j + 3] = 255; j += 4; }
      const { nativeImage } = require("electron");
      const img = nativeImage.createFromBitmap(bgra, { width: w, height: h });
      return { ok: true, data: img.toDataURL() };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  try { const b = fs.readFileSync(png); return { ok: true, data: "data:image/png;base64," + b.toString("base64") }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// ---------- MCP (Model Context Protocol) client: stdio + HTTP(JSON-RPC/SSE) ----------
// Dependency-free JSON-RPC 2.0 over newline-delimited stdio OR HTTP POST. Supports tools, resources,
// prompts, lifecycle (auto-reconnect + tools/list_changed), and server->client sampling routed to local Ollama.
const mcpServers = new Map(); // name -> session
const MCP_PROTO = "2024-11-05";
let MCP_SAMPLE_MODEL = "hermes3"; // model used to answer MCP sampling requests

function mcpCleanup(name, byUser) {
  const s = mcpServers.get(name);
  if (!s) return;
  if (byUser) s.closedByUser = true;
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  for (const p of s.pending.values()) { try { p.reject(new Error("disconnected")); } catch (_) {} }
  s.pending.clear();
  try { if (s.proc) s.proc.kill("SIGKILL"); } catch (_) {}
  mcpServers.delete(name);
}
function mcpSend(s, msg) { try { s.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch (_) {} }
function mcpHttpPost(s, body) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(s.url); } catch (e) { return reject(e); }
    const mod = u.protocol === "https:" ? https : http;
    const data = JSON.stringify(body);
    const headers = Object.assign({ "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Content-Length": Buffer.byteLength(data) }, s.headers || {});
    if (s.sessionId) headers["Mcp-Session-Id"] = s.sessionId;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "POST", headers }, (res) => {
      const sid = res.headers["mcp-session-id"]; if (sid) s.sessionId = sid;
      const ct = res.headers["content-type"] || ""; let buf = "";
      res.on("data", (c) => (buf += c)); res.on("end", () => resolve({ status: res.statusCode, ct, buf }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
function mcpParseMessages(ct, buf) {
  if (/event-stream/.test(ct)) { const out = []; for (const line of buf.split(/\r?\n/)) { const m = line.match(/^data:\s?(.*)$/); if (m) { try { out.push(JSON.parse(m[1])); } catch (_) {} } } return out; }
  try { const j = JSON.parse(buf); return Array.isArray(j) ? j : [j]; } catch (_) { return []; }
}
function mcpLocalSample(params) {
  return new Promise((resolve, reject) => {
    const msgs = (params.messages || []).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: (m.content && (m.content.text != null ? m.content.text : (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))) || "" }));
    if (params.systemPrompt) msgs.unshift({ role: "system", content: params.systemPrompt });
    const data = JSON.stringify({ model: MCP_SAMPLE_MODEL, stream: false, messages: msgs, options: { temperature: params.temperature != null ? params.temperature : 0.7 } });
    const req = http.request({ host: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { const j = JSON.parse(b); resolve({ role: "assistant", content: { type: "text", text: (j.message && j.message.content) || "" }, model: MCP_SAMPLE_MODEL, stopReason: "endTurn" }); } catch (e) { reject(e); } }); });
    req.on("error", reject); req.write(data); req.end();
  });
}
async function mcpHandleServerRequest(s, msg) {
  let result, error;
  try {
    if (msg.method === "sampling/createMessage") result = await mcpLocalSample(msg.params || {});
    else if (msg.method === "roots/list") result = { roots: s.roots || [] };
    else if (msg.method === "ping") result = {};
    else error = { code: -32601, message: "method not supported: " + msg.method };
  } catch (e) { error = { code: -32603, message: e.message }; }
  const reply = error ? { jsonrpc: "2.0", id: msg.id, error } : { jsonrpc: "2.0", id: msg.id, result };
  if (s.transport === "http") mcpHttpPost(s, reply).catch(() => {}); else mcpSend(s, reply);
}
function mcpDispatch(s, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.method) {
    if (msg.id != null) { mcpHandleServerRequest(s, msg); return; }           // server -> client request
    if (msg.method === "notifications/tools/list_changed") mcpRefreshTools(s); // notification
    return;
  }
  if (msg.id != null && s.pending.has(msg.id)) { const p = s.pending.get(msg.id); s.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message || "MCP error")); else p.resolve(msg.result); }
}
function mcpOnData(s, chunk) {
  s.buf += chunk.toString(); let nl;
  while ((nl = s.buf.indexOf("\n")) >= 0) { const line = s.buf.slice(0, nl).trim(); s.buf = s.buf.slice(nl + 1); if (!line) continue; let msg; try { msg = JSON.parse(line); } catch (_) { continue; } mcpDispatch(s, msg); }
}
async function mcpRequest(s, method, params, timeout) {
  if (s.transport === "http") {
    const id = s.nextId++;
    const { status, ct, buf } = await mcpHttpPost(s, { jsonrpc: "2.0", id, method, params: params || {} });
    if (status >= 400) throw new Error("HTTP " + status + ": " + String(buf).slice(0, 200));
    const msgs = mcpParseMessages(ct, buf); let result, err, seen = false;
    for (const m of msgs) { if (m && m.id === id) { seen = true; if (m.error) err = m.error; else result = m.result; } else mcpDispatch(s, m); }
    if (err) throw new Error(err.message || "MCP error");
    if (!seen && method !== "initialize") return result;
    return result;
  }
  return new Promise((resolve, reject) => {
    const id = s.nextId++; s.pending.set(id, { resolve, reject });
    mcpSend(s, { jsonrpc: "2.0", id, method, params: params || {} });
    setTimeout(() => { if (s.pending.has(id)) { s.pending.delete(id); reject(new Error("MCP request timed out: " + method)); } }, timeout || 30000);
  });
}
function mcpNotify(s, method, params) { if (s.transport === "http") mcpHttpPost(s, { jsonrpc: "2.0", method, params: params || {} }).catch(() => {}); else mcpSend(s, { jsonrpc: "2.0", method, params: params || {} }); }
async function mcpRefreshTools(s) { try { const tl = await mcpRequest(s, "tools/list", {}, 20000); s.tools = (tl && tl.tools) || []; } catch (_) {} }
function mcpScheduleReconnect(s) {
  if (s.closedByUser || s.reconnectTimer) return;
  s.reconnectTimer = setTimeout(() => { s.reconnectTimer = null; if (!s.closedByUser) mcpConnect(s.cfg).catch(() => {}); }, 3000);
}
async function mcpConnect(cfg) {
  const name = cfg && cfg.name; if (!name) return { ok: false, error: "name is required" };
  const transport = cfg.transport === "http" ? "http" : "stdio";
  mcpCleanup(name);
  const s = { name, cfg, transport, buf: "", nextId: 1, pending: new Map(), tools: [], resources: [], prompts: [], info: null, caps: {}, roots: cfg.roots || [], closedByUser: false, spawnErr: "" };
  if (transport === "http") {
    if (!cfg.url) return { ok: false, error: "url is required for http transport" };
    s.url = cfg.url; s.headers = cfg.headers || {};
  } else {
    if (!cfg.command) return { ok: false, error: "command is required for stdio transport" };
    let proc; try { proc = spawn(cfg.command, cfg.args || [], { env: Object.assign({}, process.env, cfg.env || {}), stdio: ["pipe", "pipe", "pipe"] }); } catch (e) { return { ok: false, error: e.message }; }
    s.proc = proc;
    proc.stderr.on("data", (d) => { s.spawnErr = (s.spawnErr + d.toString()).slice(-600); });
    proc.stdout.on("data", (d) => mcpOnData(s, d));
    proc.on("error", (e) => { for (const p of s.pending.values()) p.reject(e); s.pending.clear(); });
    proc.on("exit", () => { for (const p of s.pending.values()) p.reject(new Error("MCP server exited")); s.pending.clear(); if (!s.closedByUser) mcpScheduleReconnect(s); });
  }
  mcpServers.set(name, s);
  try {
    const init = await mcpRequest(s, "initialize", { protocolVersion: MCP_PROTO, capabilities: { sampling: {}, roots: { listChanged: false } }, clientInfo: { name: "Sentinel", version: app.getVersion() } }, 20000);
    s.info = (init && init.serverInfo) || null; s.caps = (init && init.capabilities) || {};
    mcpNotify(s, "notifications/initialized", {});
    await mcpRefreshTools(s);
    try { if (s.caps.resources) { const r = await mcpRequest(s, "resources/list", {}, 15000); s.resources = (r && r.resources) || []; } } catch (_) {}
    try { if (s.caps.prompts) { const r = await mcpRequest(s, "prompts/list", {}, 15000); s.prompts = (r && r.prompts) || []; } } catch (_) {}
    return { ok: true, name, tools: s.tools, resources: s.resources, prompts: s.prompts, info: s.info };
  } catch (e) { const err = (e.message || "connect failed") + (s.spawnErr ? " :: " + s.spawnErr : ""); mcpCleanup(name); return { ok: false, error: err }; }
}
ipcMain.handle("mcp:connect", (_e, cfg) => mcpConnect(cfg || {}));
ipcMain.handle("mcp:list", () => ({ ok: true, servers: [...mcpServers.entries()].map(([name, s]) => ({ name, info: s.info, transport: s.transport, tools: s.tools, resources: s.resources, prompts: s.prompts })) }));
ipcMain.handle("mcp:call", async (_e, { server, tool, args }) => {
  const s = mcpServers.get(server); if (!s) return { ok: false, error: "MCP server not connected: " + server };
  try {
    const r = await mcpRequest(s, "tools/call", { name: tool, arguments: args || {} }, 120000);
    const text = Array.isArray(r && r.content) ? r.content.map((c) => (c && c.text != null ? c.text : (c && c.type === "image" ? "[image]" : JSON.stringify(c)))).join("\n") : JSON.stringify(r);
    return { ok: true, isError: !!(r && r.isError), content: text };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("mcp:readResource", async (_e, { server, uri }) => {
  const s = mcpServers.get(server); if (!s) return { ok: false, error: "not connected: " + server };
  try { const r = await mcpRequest(s, "resources/read", { uri }, 60000); const text = Array.isArray(r && r.contents) ? r.contents.map((c) => c.text != null ? c.text : (c.blob != null ? "[binary]" : JSON.stringify(c))).join("\n") : JSON.stringify(r); return { ok: true, content: text }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("mcp:getPrompt", async (_e, { server, name, args }) => {
  const s = mcpServers.get(server); if (!s) return { ok: false, error: "not connected: " + server };
  try { const r = await mcpRequest(s, "prompts/get", { name, arguments: args || {} }, 60000); return { ok: true, prompt: r }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle("mcp:sampleModel", (_e, model) => { if (model) MCP_SAMPLE_MODEL = String(model); return { ok: true, model: MCP_SAMPLE_MODEL }; });
ipcMain.handle("mcp:disconnect", (_e, name) => { mcpCleanup(name, true); return { ok: true }; });
ipcMain.handle("mcp:status", () => ({ ok: true, connected: [...mcpServers.keys()] }));

app.on("before-quit", () => {
  for (const r of vmProcs.values()) { try { r.proc.kill("SIGKILL"); } catch (_) {} }
  for (const s of mcpServers.values()) { s.closedByUser = true; if (s.reconnectTimer) { try { clearTimeout(s.reconnectTimer); } catch (_) {} } try { if (s.proc) s.proc.kill("SIGKILL"); } catch (_) {} }
});
