# Darknode (desktop app)

The Darknode security console — a cross-platform Electron app: an AI assistant, a
QEMU VM runner that can **build Darknode OS**, a native port scanner, DNS/WHOIS/TLS
recon, a code workbench, live terminals, MCP, and enterprise governance.

## Architecture

```
   Renderer  (renderer/app.js — the UI: dashboard, terminal, recon, VMs, ...)
        |
        |  contextBridge  ->  window.darknode   (preload.js — the only exposed surface)
        v
   Main process  (main.js — IPC handlers)
        |
        +-- AI          streaming: Ollama (local) · Claude · OpenAI-compatible
        +-- VM runner   QEMU + a Darknode OS builder (pick a base, build, boot)
        +-- Recon       scan · dns · whois · tls · subdomains · fuzz
        +-- Dev         git / github · pty terminals · MCP client
        +-- Governance  usage ledger · compliance bundle
        +-- Bridges     Gmail OAuth (config-based) · net:get (SSRF-guarded fetch)
        v
   OS + network  (sandboxed through the main process; the renderer never touches them directly)
```

Security boundary: the renderer has no Node access. Everything privileged goes
through `preload.js`'s `contextBridge` to typed IPC handlers in `main.js`, where
inputs are validated (e.g. `net:get` blocks loopback/link-local/private hosts).

## Project Structure

```
darknode-app/
├── main.js                    # Electron main: all IPC handlers (AI, VM, recon, git, pty, MCP)
├── preload.js                 # contextBridge — the window.darknode API surface
├── renderer/
│   └── app.js                 # UI: the section router + all views
├── lib/                       # main-process modules (anthropic, governance, ...)
├── oauth.config.example.json  # template for Gmail OAuth (real oauth.config.json is gitignored)
├── package.json
└── README.md
```

## Configuration

Native Gmail OAuth loads its client id/secret from `oauth.config.json` (gitignored)
or the `DARKNODE_GMAIL_CLIENT_ID` / `DARKNODE_GMAIL_CLIENT_SECRET` env vars — **no
credentials in source**. Copy the template to start:

```
cp oauth.config.example.json oauth.config.json   # then fill in your Desktop client
```

## Installation

```
git clone https://github.com/SpartanKing18/darknode-app
cd darknode-app && npm install
npm start                      # run in development
npm run build                  # package (.deb / AppImage / .exe)
```

## Status

Active. The VM runner can build and boot a customized Darknode OS on a chosen base
(Debian / Ubuntu / Kali) directly from the app.

## Security

The app runs local tools, VMs, and shells. The renderer is sandboxed from the OS;
all privileged actions cross a validated IPC boundary. Never commit `oauth.config.json`.

## License

See `LICENSE`.
