// Darknode recon — native content/directory fuzzer core (main-process only).
//
// Sends real GET requests to a base URL + each wordlist entry and reports any
// path that does not answer 404. A browser cannot do this across origins
// (CORS/opaque responses); the main process can, with TLS verification off for
// self-signed lab targets, bounded concurrency, and a per-request timeout.
//
// Decoupled from Electron so it is unit-testable off a loopback http server:
//   fuzzDirs(base, words, opts) -> Promise<{ hits, found, cancelled }>
//   opts: {
//     timeout      per-request ms (default 8000)
//     concurrency  max in-flight (default 25, capped 50)
//     signal       { cancelled }
//     onHit(hit)             hit = { path, status, len, loc }
//     onProgress(done, total)
//   }
//
// Verified by test/recon/fuzz.test.mjs (fuzzes a real loopback listener).

const http = require("http");
const https = require("https");

function headReq(url, to) {
  return new Promise((res) => {
    let u;
    try { u = new URL(url); } catch (_) { return res(null); }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      { method: "GET", timeout: to || 8000, rejectUnauthorized: false, headers: { "User-Agent": "Darknode" } },
      (r) => {
        const out = { status: r.statusCode, len: r.headers["content-length"] || "", loc: r.headers["location"] || "" };
        r.destroy();
        res(out);
      }
    );
    req.on("timeout", () => { req.destroy(); res(null); });
    req.on("error", () => res(null));
    req.end();
  });
}

function fuzzDirs(base, words, opts = {}) {
  base = String(base).replace(/\/+$/, "");
  const to = opts.timeout || 8000;
  const conc = Math.min(opts.concurrency || 25, 50);
  const total = words.length;
  const state = opts.signal || { cancelled: false };
  const onHit = typeof opts.onHit === "function" ? opts.onHit : () => {};
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  let idx = 0, hits = 0;
  const found = [];

  const probe = async (word) => {
    const p = "/" + String(word).replace(/^\//, "");
    const r = await headReq(base + p, to);
    if (r && r.status && r.status !== 404) {
      hits++;
      const hit = { path: p, status: r.status, len: r.len, loc: r.loc };
      found.push(hit);
      onHit(hit);
    }
  };

  const worker = async () => {
    while (!state.cancelled) {
      const i = idx++;
      if (i >= total) return;
      await probe(words[i]);
      onProgress(i + 1, total);
    }
  };

  return Promise.all(Array.from({ length: Math.min(conc, total) }, worker))
    .then(() => ({ hits, found, cancelled: state.cancelled }));
}

module.exports = { headReq, fuzzDirs };
