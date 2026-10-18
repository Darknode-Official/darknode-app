// Secure bridge: the only surface the renderer can touch.
//
// Two shells share this preload (main.js passes --dn-shell):
//   web     - the packaged website on the app origin (D0). It gets ONLY the small
//             desktop surface below, and only in the top-level frame on the exact
//             app origin; tool iframes (?embed=1), auth popups and any other origin
//             get nothing. The website already owns a mutable window.darknode
//             namespace (its assistant attaches .control/.openHelp to it), so the
//             surface is merged into that object instead of exposed as a frozen one.
//   classic - the legacy renderer/index.html (DARKNODE_CLASSIC=1), which keeps the
//             full native bridge, again only in its own top-level file:// frame.
// main.js re-checks the sender frame and channel on every IPC call, so this gate
// is defense in depth, not the only line.
const { contextBridge, ipcRenderer } = require("electron");

function argOf(name) {
  try {
    const hit = (process.argv || []).find((a) => a.startsWith("--" + name + "="));
    return hit ? hit.slice(name.length + 3) : "";
  } catch (_) { return ""; }
}
function isTopFrame() { try { return window.top === window; } catch (_) { return false; } }

const SHELL = argOf("dn-shell");

if (SHELL === "web") {
  const APP_ORIGIN = argOf("dn-app-origin");
  // location.href, not just origin: a window.open("") child is about:blank yet reports the
  // opener's origin, and must not get the bridge.
  if (APP_ORIGIN && isTopFrame() && location.origin === APP_ORIGIN && location.href.startsWith(APP_ORIGIN + "/")) {
    const caps = argOf("dn-caps").split(",").filter(Boolean);
    const api = {
      desktop: Object.freeze({ version: argOf("dn-app-version"), platform: process.platform, arch: process.arch, shell: "web", caps }),
      auth: { google: () => ipcRenderer.invoke("auth:google") },
      openExternal: (url) => ipcRenderer.invoke("openExternal", String(url || "")),
      // Recolour the native window-controls overlay to match the page's top bar.
      titlebar: (opts) => ipcRenderer.invoke("shell:titlebar", opts || {}),
    };
    contextBridge.executeInMainWorld({
      func: (bridge) => {
        const ns = window.darknode && typeof window.darknode === "object" ? window.darknode : {};
        ns.desktop = bridge.desktop;
        ns.auth = bridge.auth;
        ns.openExternal = bridge.openExternal;
        ns.titlebar = bridge.titlebar;
        window.darknode = ns;
      },
      args: [api],
    });
  }
} else if (isTopFrame() && location.protocol === "file:") {
contextBridge.exposeInMainWorld("darknode", {
  sysinfo: () => ipcRenderer.invoke("sysinfo"),
  run: (id, cmd, cwd) => ipcRenderer.invoke("run", { id, cmd, cwd }),
  kill: (id) => ipcRenderer.invoke("kill", id),
  which: (name) => ipcRenderer.invoke("which", name),
  agentExec: (command, cwd, timeout, autopass) => ipcRenderer.invoke("agent:exec", { command, cwd, timeout, autopass }),
  toolInstall: (id, install) => ipcRenderer.invoke("tool:install", { id, install }),
  onToolInstallData: (cb) => ipcRenderer.on("tool:install:data", (_e, d) => cb(d)),
  ollama: (path, body) => ipcRenderer.invoke("ollama", { path, body }),
  ollamaStream: (id, body) => ipcRenderer.invoke("ollama:stream", { id, body }),
  ollamaCancel: (id) => ipcRenderer.invoke("ollama:cancel", id),
  onOllamaToken: (cb) => ipcRenderer.on("ollama:token", (_e, d) => cb(d)),
  // Claude (Anthropic) cloud engine — same streaming contract as Ollama
  claudeStream: (id, body, apiKey) => ipcRenderer.invoke("claude:stream", { id, body, apiKey }),
  claudeCancel: (id) => ipcRenderer.invoke("claude:cancel", id),
  onClaudeToken: (cb) => ipcRenderer.on("claude:token", (_e, d) => cb(d)),
  // Any model via an OpenAI-compatible API — same streaming contract as Ollama/Claude
  apiStream: (id, body, base, apiKey, model) => ipcRenderer.invoke("api:stream", { id, body, base, apiKey, model }),
  apiCancel: (id) => ipcRenderer.invoke("api:cancel", id),
  onApiToken: (cb) => ipcRenderer.on("api:token", (_e, d) => cb(d)),
  // Darknode AI (cloud) — routes through the darknode.ai proxy; no key on device,
  // web access included, cite:false (the app never shows a Sources list).
  daiStream: (id, messages) => ipcRenderer.invoke("dai:stream", { id, messages }),
  daiCancel: (id) => ipcRenderer.invoke("dai:cancel", id),
  onDaiToken: (cb) => ipcRenderer.on("dai:token", (_e, d) => cb(d)),
  // enterprise governance: usage ledger + compliance bundle
  govIdentity: () => ipcRenderer.invoke("gov:identity"),
  govUsageAppend: (rec) => ipcRenderer.invoke("gov:usage:append", rec),
  govUsageReport: (opts) => ipcRenderer.invoke("gov:usage:report", opts),
  govComplianceBuild: (opts) => ipcRenderer.invoke("gov:compliance:build", opts),
  govComplianceVerify: (bundle, signingKey) => ipcRenderer.invoke("gov:compliance:verify", { bundle, signingKey }),
  // Workstation Security Audit (CIS Level 1-style, read-only, main-process).
  auditRun: () => ipcRenderer.invoke("audit:run"),
  auditExport: (report, format) => ipcRenderer.invoke("audit:export", { report, format }),
  auditSave: (text, defaultName, ext) => ipcRenderer.invoke("audit:save", { text, defaultName, ext }),
  openExternal: (url) => ipcRenderer.invoke("openExternal", url),
  winMin: () => ipcRenderer.invoke("win:minimize"),
  winMax: () => ipcRenderer.invoke("win:maximize"),
  winClose: () => ipcRenderer.invoke("win:close"),
  checkUpdate: () => ipcRenderer.invoke("app:checkUpdate"),
  installUpdate: () => ipcRenderer.invoke("app:installUpdate"),
  onUpdate: (cb) => ipcRenderer.on("app:update", (_e, s) => { try { cb(s); } catch (_) {} }),
  noBootAnim: (() => { try { return process.env.DARKNODE_NO_BOOT === "1" || process.argv.includes("--no-boot-anim"); } catch (_) { return false; } })(),
  gmailOAuth: (creds) => ipcRenderer.invoke("gmail:oauth", creds),
  gmailRefresh: (arg) => ipcRenderer.invoke("gmail:refresh", arg),
  netGet: (opts) => ipcRenderer.invoke("net:get", opts),
  onWinState: (cb) => ipcRenderer.on("win:state", (_e, max) => cb(max)),
  httpReq: (opts) => ipcRenderer.invoke("http:request", opts),
  cveSearch: (q, opts) => ipcRenderer.invoke("cve:search", q, opts),
  resultsList: () => ipcRenderer.invoke("results:list"),
  resultsRead: (name) => ipcRenderer.invoke("results:read", name),
  resultsReveal: () => ipcRenderer.invoke("results:reveal"),
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),
  openFile: (filters) => ipcRenderer.invoke("dialog:openFile", filters),
  vmDeps: () => ipcRenderer.invoke("vm:deps"),
  vmList: () => ipcRenderer.invoke("vm:list"),
  vmCreate: (opts) => ipcRenderer.invoke("vm:create", opts),
  vmUpdate: (id, patch) => ipcRenderer.invoke("vm:update", { id, patch }),
  vmDelete: (id, deleteDisk) => ipcRenderer.invoke("vm:delete", { id, deleteDisk }),
  vmStart: (id) => ipcRenderer.invoke("vm:start", { id }),
  vmStop: (id, force) => ipcRenderer.invoke("vm:stop", { id, force }),
  vmReset: (id) => ipcRenderer.invoke("vm:reset", { id }),
  vmKey: (id, keys) => ipcRenderer.invoke("vm:key", { id, keys }),
  vmScreendump: (id) => ipcRenderer.invoke("vm:screendump", { id }),
  vmMouse: (id, x, y, down, up) => ipcRenderer.invoke("vm:mouse", { id, x, y, down, up }),
  onVmExit: (cb) => ipcRenderer.on("vm:exit", (_e, d) => cb(d)),
  fsList: (dir) => ipcRenderer.invoke("fs:list", dir),
  fsRead: (file) => ipcRenderer.invoke("fs:read", file),
  forensicsAnalyze: (file) => ipcRenderer.invoke("forensics:analyze", file),
  fsWrite: (file, data) => ipcRenderer.invoke("fs:write", { file, data }),
  fsMkfile: (dir, name) => ipcRenderer.invoke("fs:mkfile", { dir, name }),
  dnsLookup: (host) => ipcRenderer.invoke("dns:lookup", host),
  whois: (query) => ipcRenderer.invoke("whois:query", query),
  tlsCert: (host, port) => ipcRenderer.invoke("tls:cert", { host, port }),
  subdomains: (domain) => ipcRenderer.invoke("subdomains:find", domain),
  gitClone: (url, token) => ipcRenderer.invoke("git:clone", { url, token }),
  gitStatus: (dir) => ipcRenderer.invoke("git:status", dir),
  gitPush: (opts) => ipcRenderer.invoke("git:push", opts),
  gitPull: (dir, token) => ipcRenderer.invoke("git:pull", { dir, token }),
  gitBranches: (dir) => ipcRenderer.invoke("git:branches", dir),
  gitCheckout: (dir, branch) => ipcRenderer.invoke("git:checkout", { dir, branch }),
  gitCheckoutNew: (dir, branch) => ipcRenderer.invoke("git:checkoutNew", { dir, branch }),
  gitLog: (dir) => ipcRenderer.invoke("git:log", dir),
  gitDiff: (dir, file) => ipcRenderer.invoke("git:diff", { dir, file }),
  ghRepos: (token) => ipcRenderer.invoke("github:repos", token),
  ghIssues: (dir, token) => ipcRenderer.invoke("github:issues", { dir, token }),
  ghCreateIssue: (opts) => ipcRenderer.invoke("github:createIssue", opts),
  ghCreatePR: (opts) => ipcRenderer.invoke("github:createPR", opts),
  ghComment: (opts) => ipcRenderer.invoke("github:comment", opts),
  ghCreateGist: (opts) => ipcRenderer.invoke("github:createGist", opts),
  // Scope authorization (DA-009): create/list/revoke authorization records and
  // preview whether an active action is in scope. The real gate is enforced in main.
  scopeAuthorize: (rec) => ipcRenderer.invoke("scope:authorize", rec),
  scopeList: () => ipcRenderer.invoke("scope:list"),
  scopeRevoke: (id) => ipcRenderer.invoke("scope:revoke", id),
  scopeCheck: (kind, target) => ipcRenderer.invoke("scope:check", { kind, target }),
  // Credential vault (DA-008): secrets are encrypted at rest with the OS user's
  // keychain key in the main process; the renderer only ever hands over / asks
  // for a named value and never writes ciphertext itself.
  secretSet: (name, value) => ipcRenderer.invoke("secret:set", { name, value }),
  secretGet: (name) => ipcRenderer.invoke("secret:get", name),
  secretHas: (name) => ipcRenderer.invoke("secret:has", name),
  secretList: () => ipcRenderer.invoke("secret:list"),
  secretRemove: (name) => ipcRenderer.invoke("secret:remove", name),
  secretMode: () => ipcRenderer.invoke("secret:mode"),
  scanPorts: (opts) => ipcRenderer.invoke("scan:ports", opts),
  scanCancel: (id) => ipcRenderer.invoke("scan:cancel", id),
  onScanHit: (cb) => ipcRenderer.on("scan:hit", (_e, d) => cb(d)),
  onScanProgress: (cb) => ipcRenderer.on("scan:progress", (_e, d) => cb(d)),
  onScanDone: (cb) => ipcRenderer.on("scan:done", (_e, d) => cb(d)),
  fuzzDirs: (opts) => ipcRenderer.invoke("fuzz:dirs", opts),
  fuzzCancel: (id) => ipcRenderer.invoke("fuzz:cancel", id),
  onFuzzHit: (cb) => ipcRenderer.on("fuzz:hit", (_e, d) => cb(d)),
  onFuzzProgress: (cb) => ipcRenderer.on("fuzz:progress", (_e, d) => cb(d)),
  onFuzzDone: (cb) => ipcRenderer.on("fuzz:done", (_e, d) => cb(d)),
  onRunData: (cb) => ipcRenderer.on("run:data", (_e, d) => cb(d)),
  onRunEnd: (cb) => ipcRenderer.on("run:end", (_e, d) => cb(d)),
  ptySpawn: (cols, rows) => ipcRenderer.invoke("pty:spawn", { cols, rows }),
  ptyWrite: (id, data) => ipcRenderer.invoke("pty:write", { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke("pty:resize", { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.invoke("pty:kill", { id }),
  onPtyData: (cb) => ipcRenderer.on("pty:data", (_e, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on("pty:exit", (_e, d) => cb(d)),
  mcpConnect: (cfg) => ipcRenderer.invoke("mcp:connect", cfg),
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpCall: (server, tool, args) => ipcRenderer.invoke("mcp:call", { server, tool, args }),
  mcpReadResource: (server, uri) => ipcRenderer.invoke("mcp:readResource", { server, uri }),
  mcpGetPrompt: (server, name, args) => ipcRenderer.invoke("mcp:getPrompt", { server, name, args }),
  mcpSampleModel: (model) => ipcRenderer.invoke("mcp:sampleModel", model),
  mcpDisconnect: (name) => ipcRenderer.invoke("mcp:disconnect", name),
  mcpStatus: () => ipcRenderer.invoke("mcp:status"),
});
}
