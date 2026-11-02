// Web-shell static server (D0): path traversal is impossible, Firebase Hosting
// headers/rewrites are mirrored, and the protocol handler answers correctly.
import { test, group, assert } from "../harness.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import S from "../../lib/webshell/serve.js";

const { resolveWebPath, route, headersFor, globMatch, createHandler, contentType } = S;

// Fixture: <tmp>/web (served root) next to <tmp>/secret.txt (must stay unreachable).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-serve-"));
const root = path.join(tmp, "web");
fs.mkdirSync(path.join(root, "js"), { recursive: true });
fs.mkdirSync(path.join(root, "quelvra"), { recursive: true });
fs.mkdirSync(path.join(root, ".well-known"), { recursive: true });
fs.mkdirSync(path.join(root, "empty-dir"), { recursive: true });
fs.writeFileSync(path.join(root, "index.html"), "<!doctype html>INDEX");
fs.writeFileSync(path.join(root, "js", "app.js"), "export const x = 1;");
fs.writeFileSync(path.join(root, "quelvra", "index.html"), "QUELVRA");
fs.writeFileSync(path.join(root, "version.txt"), "v1");
fs.writeFileSync(path.join(root, ".source.json"), "{}");
fs.writeFileSync(path.join(root, ".well-known", "security.txt"), "Contact: x");
fs.writeFileSync(path.join(tmp, "secret.txt"), "TOP SECRET");
let symlinkMade = false;
try { fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(root, "link.txt")); symlinkMade = true; } catch (_) {}

const HOSTING = {
  headers: [
    { source: "**", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }, { key: "Content-Security-Policy", value: "default-src 'self'" }] },
    { source: "/quelvra/**", headers: [{ key: "Content-Security-Policy", value: "quelvra" }] },
    { source: "**/*.@(js|css)", headers: [{ key: "Cache-Control", value: "public, max-age=300" }] },
  ],
  rewrites: [
    { source: "/api/chat", function: { functionId: "chat" } },
    { source: "/version", destination: "/version.txt" },
    { source: "**", destination: "/index.html" },
  ],
};

group("webshell.serve: path traversal is impossible", () => {
  const ATTACKS = [
    "/../secret.txt", "/js/../../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt",
    "/js/%2e%2e%2f%2e%2e%2fsecret.txt", "/..%2fsecret.txt", "/..%5csecret.txt", "/js\\..\\..\\secret.txt",
    "/%00index.html", "/index.html%00.js", "/%252e%252e/secret.txt", "/.source.json", "/js/.hidden",
    "/%c0%ae%c0%ae/secret.txt",
  ];
  for (const a of ATTACKS) {
    test(`never serves outside web/ for ${JSON.stringify(a)}`, () => {
      const r = resolveWebPath(root, a);
      if (r.file) assert.ok(path.resolve(r.file).startsWith(path.resolve(root) + path.sep), "escaped: " + r.file);
      const out = route(root, HOSTING, "GET", a);
      if (out.file) assert.notEqual(fs.readFileSync(out.file, "utf8"), "TOP SECRET");
    });
  }
  test("dot-segments and encoded traversal are refused outright", () => {
    assert.ok(resolveWebPath(root, "/%2e%2e/secret.txt").forbidden);
    assert.ok(resolveWebPath(root, "/..%2fsecret.txt").forbidden);
    assert.ok(resolveWebPath(root, "/a%00b").forbidden);
    assert.ok(resolveWebPath(root, "/a\\b").forbidden);
    assert.equal(route(root, HOSTING, "GET", "/.source.json").status, 403);
  });
  test("malformed percent-encoding is refused", () => assert.ok(resolveWebPath(root, "/%E0%A4%A").forbidden));
  test("a symlink pointing outside web/ is refused", () => {
    if (!symlinkMade) return; // platform without symlink permission
    assert.ok(resolveWebPath(root, "/link.txt").forbidden);
  });
  test("/.well-known/ stays reachable", () => assert.ok(resolveWebPath(root, "/.well-known/security.txt").file));
});

group("webshell.serve: Firebase Hosting semantics", () => {
  test("existing file is served", () => { const r = route(root, HOSTING, "GET", "/js/app.js"); assert.equal(r.status, 200); assert.ok(r.file.endsWith(path.join("js", "app.js"))); });
  test("SPA route falls back to index.html with 200", () => { const r = route(root, HOSTING, "GET", "/navarch"); assert.equal(r.status, 200); assert.ok(r.file.endsWith("index.html")); assert.equal(fs.readFileSync(r.file, "utf8"), "<!doctype html>INDEX"); });
  test("/version rewrites to /version.txt", () => assert.ok(route(root, HOSTING, "GET", "/version").file.endsWith("version.txt")));
  test("function rewrite has no local backend -> 404", () => assert.equal(route(root, HOSTING, "GET", "/api/chat").status, 404));
  test("directory without trailing slash redirects", () => { const r = route(root, HOSTING, "GET", "/quelvra"); assert.equal(r.status, 301); assert.equal(r.headers.Location, "/quelvra/"); });
  test("directory index is served", () => assert.ok(route(root, HOSTING, "GET", "/quelvra/").file.endsWith(path.join("quelvra", "index.html"))));
  test("non-GET methods are refused", () => assert.equal(route(root, HOSTING, "POST", "/").status, 405));
  test("every response carries the hosting security headers", () => {
    for (const p of ["/", "/navarch", "/js/app.js", "/.source.json", "/nope/x.png"]) assert.equal(route(root, HOSTING, "GET", p).headers["X-Frame-Options"], "SAMEORIGIN", p);
  });
  test("later matching header blocks override earlier ones", () => {
    assert.equal(headersFor("/quelvra/app.js", HOSTING)["Content-Security-Policy"], "quelvra");
    assert.equal(headersFor("/js/app.js", HOSTING)["Content-Security-Policy"], "default-src 'self'");
    assert.equal(headersFor("/js/app.js", HOSTING)["Cache-Control"], "public, max-age=300");
  });
  test("globs: **, @(a|b), exact", () => {
    assert.ok(globMatch("**", "/anything/at/all"));
    assert.ok(globMatch("**/*.@(svg|png|ico|woff2)", "/a/b/logo.svg"));
    assert.ok(globMatch("**/*.@(svg|png|ico|woff2)", "/logo.png"));
    assert.notOk(globMatch("**/*.@(svg|png)", "/logo.svgz"));
    assert.ok(globMatch("/version", "/version"));
    assert.notOk(globMatch("/version", "/versions"));
    assert.ok(globMatch("/quelvra/**", "/quelvra/x/y.js"));
  });
  test("content types", () => {
    assert.equal(contentType("a.js"), "text/javascript; charset=utf-8");
    assert.equal(contentType("a.wasm"), "application/wasm");
    assert.equal(contentType("a.unknown"), "application/octet-stream");
  });
});

group("webshell.serve: protocol handler", () => {
  const handle = createHandler({ root, hosting: HOSTING, transform: (p, buf) => (p.endsWith(".js") ? Buffer.from(buf.toString().replace("1", "2")) : null) });
  test("serves a file with type, no-cache and hosting headers", async () => {
    const r = await handle(new Request("http://localhost:47913/js/app.js"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "no-cache");
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(await r.text(), "export const x = 2;"); // transform applied
  });
  test("traversal over the wire gets 403 and never the secret", async () => {
    for (const u of ["http://localhost:47913/%2e%2e/secret.txt", "http://localhost:47913/..%2fsecret.txt"]) {
      const r = await handle(new Request(u));
      assert.notEqual(await r.text(), "TOP SECRET", u);
    }
    assert.equal((await handle(new Request("http://localhost:47913/..%2fsecret.txt"))).status, 403);
  });
  test("SPA route answers with index.html", async () => assert.equal(await (await handle(new Request("http://localhost:47913/hashsuite?embed=1"))).text(), "<!doctype html>INDEX"));
});
