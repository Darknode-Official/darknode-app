// Native-path test for lib/recon/fuzz.js (DA-002).
//
// Exercises the REAL content fuzzer against a loopback HTTP server we control.
// Deterministic and offline: no external host is contacted.
import { test, group, assert } from "../harness.mjs";
import http from "node:http";
import F from "../../lib/recon/fuzz.js";

const { fuzzDirs, headReq } = F;

// Start an HTTP server: /secret -> 200, /moved -> 301, everything else -> 404.
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, r) => {
      if (req.url === "/secret") { r.writeHead(200, { "content-length": "5" }); r.end("found"); }
      else if (req.url === "/moved") { r.writeHead(301, { location: "/secret" }); r.end(); }
      else { r.writeHead(404); r.end(); }
    });
    srv.listen(0, "127.0.0.1", () => res({ base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((rr) => srv.close(rr)) }));
  });
}

group("recon: fuzz (native HTTP content discovery)", () => {
  test("finds a non-404 path and skips 404s", async () => {
    const { base, close } = await serve();
    try {
      const hits = [];
      const r = await fuzzDirs(base, ["secret", "nope", "alsomissing"], { timeout: 1500, onHit: (h) => hits.push(h) });
      assert.equal(r.hits, 1, "exactly one hit expected");
      assert.equal(r.found[0].path, "/secret");
      assert.equal(r.found[0].status, 200);
      assert.equal(hits.length, 1, "onHit should fire for the hit");
    } finally { await close(); }
  });

  test("reports a redirect (3xx) with its Location", async () => {
    const { base, close } = await serve();
    try {
      const r = await fuzzDirs(base, ["moved"], { timeout: 1500 });
      assert.equal(r.hits, 1);
      assert.equal(r.found[0].status, 301);
      assert.equal(r.found[0].loc, "/secret");
    } finally { await close(); }
  });

  test("headReq returns null for an unreachable base", async () => {
    // Port 1 on loopback refuses immediately -> null, no throw.
    const out = await headReq("http://127.0.0.1:1/x", 500);
    assert.equal(out, null);
  });
});
