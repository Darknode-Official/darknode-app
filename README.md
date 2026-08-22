# Sentinel (desktop)

The powerful, downloadable version of Sentinel. Unlike the website, this native app
has a Node backend, so it **actually runs tools** on your machine with live streamed
output, and talks to your **local Ollama**.

- **Terminal** - a real interactive shell (xterm.js + node-pty): colors, TUIs, and
  password/ssh prompts all work, not just streamed output.
- **Tools** - install-check + one-click run for nmap, nikto, gobuster, sqlmap, nuclei,
  and more (editable commands), plus in-app utilities (Base64, hashes, reverse-shell).
- **Local AI** - chat with your Ollama models (`ollama serve` + `ollama pull ...`).
- Dark/light themes + accent color.

Security: the renderer runs with `contextIsolation` and **no Node access** — it can
only reach the main process through the small preload bridge (`preload.js`).

## Run from source
```
npm install
npm start
```

Native module note: `node-pty` is compiled per platform. `npm install` runs
`electron-builder install-app-deps` (postinstall) to rebuild it against Electron's
ABI, and `electron-builder` rebuilds it again for each target when packaging.

## Build installers
Each OS builds its own native installer (electron-builder):
```
npm run dist:linux   # -> dist/*.AppImage, dist/*.deb   (run on Linux)
npm run dist:win     # -> dist/*.exe                     (run on Windows)
npm run dist:mac     # -> dist/*.dmg                     (run on macOS)
```
You must build each target on that OS (macOS/Windows can't be produced from Linux
reliably, and signing needs the native platform). The included GitHub Actions workflow
(`.github/workflows/build.yml`) builds **all three** on a tagged push (`git tag v1.0.0
&& git push --tags`) and uploads the installers as artifacts — the simplest way to get
Linux/Windows/Mac builds without three machines.

## Distribute
Upload the built installers to a GitHub **Release**, then point the website's
"Download the app" buttons at that release.
