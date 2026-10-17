// sync-web (D0): packages darknode-web/public into web/, excluding installers,
// hosting-ignored files and oversized files; mirrors firebase.json hosting rules;
// vendors the Firebase SDK; records provenance. Network is injected.
import { test, group, assert } from "../harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncWeb } from "../../scripts/sync-web.mjs";

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dn-sync-"));
  const pub = path.join(repo, "public");
  const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(pub, rel)), { recursive: true }); fs.writeFileSync(path.join(pub, rel), data); };
  w("index.html", '<link rel="modulepreload" href="https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js">');
  w("js/auth.js", 'import { x } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js";');
  w("css/site.css", "body{}");
  w("downloads/Darknode-linux.AppImage", "installer");
  w("downloads/README.txt", "readme");
  w("data/big.json", Buffer.alloc(2048, 1));
  w("tools/setup.exe", "exe");
  w(".well-known/security.txt", "Contact: x");
  fs.writeFileSync(path.join(repo, "firebase.json"), JSON.stringify({ hosting: [{ public: "public", ignore: ["firebase/**", "**/*.exe"], headers: [{ source: "**", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] }], rewrites: [{ source: "**", destination: "/index.html" }] }] }));
  return { repo, pub, dest: path.join(repo, "out", "web") };
}

// Fake CDN: auth imports app, app imports nothing.
const CDN = {
  "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js": "export const app = 1;",
  "https://www.gstatic.com/firebasejs/12.17.0/firebase-auth.js": 'import "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js"; export const x = 1;',
};
const okFetch = async (u) => (CDN[u] ? { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(CDN[u]).buffer } : { ok: false, status: 404 });
const deadFetch = async () => { throw new Error("offline"); };

group("sync-web", () => {
  test("copies the site and excludes installers, ignored and oversized files", async () => {
    const f = fixture();
    const meta = await syncWeb({ src: f.pub, dest: f.dest, maxBytes: 1024, fetchImpl: okFetch, cacheDir: null });
    assert.ok(fs.existsSync(path.join(f.dest, "index.html")));
    assert.ok(fs.existsSync(path.join(f.dest, "js", "auth.js")));
    assert.ok(fs.existsSync(path.join(f.dest, ".well-known", "security.txt")));
    assert.notOk(fs.existsSync(path.join(f.dest, "downloads")));
    assert.notOk(fs.existsSync(path.join(f.dest, "tools", "setup.exe")));
    assert.notOk(fs.existsSync(path.join(f.dest, "data", "big.json")));
    const ex = Object.fromEntries(meta.excluded.map((e) => [e.path, e.reason]));
    assert.equal(ex["downloads/"], "installers (public/downloads)");
    assert.equal(ex["tools/setup.exe"], "firebase.json hosting ignore");
    assert.ok(/^over /.test(ex["data/big.json"]));
    assert.equal(meta.excluded.find((e) => e.path === "data/big.json").bytes, 2048);
  });
  test("writes provenance and hosting rules", async () => {
    const f = fixture();
    await syncWeb({ src: f.pub, dest: f.dest, fetchImpl: okFetch, cacheDir: null });
    const src = JSON.parse(fs.readFileSync(path.join(f.dest, ".source.json"), "utf8"));
    assert.equal(src.source.path, "public");
    assert.ok("commit" in src.source && "dirty" in src.source);
    assert.notOk(JSON.stringify(src.source).includes(os.tmpdir()), "no local paths in provenance");
    assert.ok(src.files >= 4);
    const hosting = JSON.parse(fs.readFileSync(path.join(f.dest, ".hosting.json"), "utf8"));
    assert.equal(hosting.headers[0].headers[0].value, "SAMEORIGIN");
    assert.equal(hosting.rewrites[0].destination, "/index.html");
  });
  test("vendors the Firebase SDK, following its own imports", async () => {
    const f = fixture();
    const meta = await syncWeb({ src: f.pub, dest: f.dest, fetchImpl: okFetch, cacheDir: null });
    assert.equal(meta.vendored.length, 2);
    assert.equal(fs.readFileSync(path.join(f.dest, "__vendor/www.gstatic.com/firebasejs/12.17.0/firebase-app.js"), "utf8"), CDN["https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js"]);
    assert.ok(meta.vendored.every((v) => /^[0-9a-f]{64}$/.test(v.sha256)));
    assert.equal(meta.vendorFailed.length, 0);
  });
  test("offline rebuild reuses the vendor cache; no cache records the failure", async () => {
    const f = fixture();
    const cache = path.join(f.repo, "cache");
    await syncWeb({ src: f.pub, dest: f.dest, fetchImpl: okFetch, cacheDir: cache });
    const again = await syncWeb({ src: f.pub, dest: f.dest, fetchImpl: deadFetch, cacheDir: cache });
    assert.equal(again.vendored.length, 2);
    assert.ok(again.vendored.every((v) => v.from === "cache"));
    const g = fixture();
    const none = await syncWeb({ src: g.pub, dest: g.dest, fetchImpl: deadFetch, cacheDir: null });
    assert.equal(none.vendored.length, 0);
    assert.equal(none.vendorFailed.length, 2);
    assert.ok(fs.existsSync(path.join(g.dest, "index.html")), "the site is still packaged");
  });
  test("refuses to wipe a directory it did not create, or a dest inside the source", async () => {
    const f = fixture();
    fs.mkdirSync(f.dest, { recursive: true });
    fs.writeFileSync(path.join(f.dest, "precious.txt"), "keep me");
    let threw = false;
    try { await syncWeb({ src: f.pub, dest: f.dest, vendor: false }); } catch (_) { threw = true; }
    assert.ok(threw);
    assert.equal(fs.readFileSync(path.join(f.dest, "precious.txt"), "utf8"), "keep me");
    let threw2 = false;
    try { await syncWeb({ src: f.pub, dest: path.join(f.pub, "web"), vendor: false }); } catch (_) { threw2 = true; }
    assert.ok(threw2);
  });
  test("re-sync replaces a previous bundle (stale files removed)", async () => {
    const f = fixture();
    await syncWeb({ src: f.pub, dest: f.dest, vendor: false });
    fs.rmSync(path.join(f.pub, "css", "site.css"));
    await syncWeb({ src: f.pub, dest: f.dest, vendor: false });
    assert.notOk(fs.existsSync(path.join(f.dest, "css", "site.css")));
  });
  test("rejects a source that is not the website", async () => {
    let threw = false;
    try { await syncWeb({ src: os.tmpdir(), dest: path.join(os.tmpdir(), "x-web"), vendor: false }); } catch (_) { threw = true; }
    assert.ok(threw);
  });
});
