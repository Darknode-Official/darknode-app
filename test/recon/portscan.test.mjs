// Native-path test for lib/recon/portscan.js (DA-002).
//
// Exercises the REAL TCP connect scan against a loopback listener we control —
// the capability the web console cannot have. Deterministic and offline: no
// external host is contacted.
import { test, group, assert } from "../harness.mjs";
import net from "node:net";
import PS from "../../lib/recon/portscan.js";

const { scanPorts } = PS;

// Start a TCP server on an ephemeral loopback port; resolve with { port, close }.
function listen(onConn) {
  return new Promise((res) => {
    const srv = net.createServer(onConn || (() => {}));
    srv.listen(0, "127.0.0.1", () => res({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)), srv }));
  });
}

// Find a port that is (almost certainly) closed: bind then immediately release.
function closedPort() {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

group("recon: portscan (native TCP connect)", () => {
  test("reports an open loopback port and skips a closed one", async () => {
    const { port, close } = await listen();
    const closed = await closedPort();
    try {
      const r = await scanPorts("127.0.0.1", [port, closed], { timeout: 500, concurrency: 8 });
      const openPorts = r.hits.map((h) => h.port);
      assert.ok(openPorts.includes(port), `expected open port ${port} in ${JSON.stringify(openPorts)}`);
      assert.ok(!openPorts.includes(closed), `closed port ${closed} must not be reported open`);
      assert.equal(r.open, 1, "exactly one open port expected");
    } finally { await close(); }
  });

  test("grabs a service banner when the server sends one", async () => {
    const { port, close } = await listen((sock) => { sock.write("SSH-2.0-DarknodeTest\r\n"); });
    try {
      const hits = [];
      const r = await scanPorts("127.0.0.1", [port], { timeout: 500, onHit: (p, b) => hits.push([p, b]) });
      assert.equal(r.open, 1);
      assert.ok(/SSH-2\.0-DarknodeTest/.test(r.hits[0].banner), `banner was ${JSON.stringify(r.hits[0].banner)}`);
      assert.equal(hits.length, 1, "onHit should fire once");
    } finally { await close(); }
  });

  test("onProgress fires once per probed port", async () => {
    const closed1 = await closedPort();
    const closed2 = await closedPort();
    let progress = 0;
    const r = await scanPorts("127.0.0.1", [closed1, closed2], { timeout: 300, onProgress: () => progress++ });
    assert.equal(progress, 2, "onProgress should fire per port");
    assert.equal(r.open, 0, "no open ports expected");
  });

  test("honors a cancel signal", async () => {
    const closed = await closedPort();
    const signal = { cancelled: true };
    const r = await scanPorts("127.0.0.1", [closed, closed, closed], { timeout: 300, signal });
    assert.ok(r.cancelled, "result should report cancelled");
    assert.equal(r.open, 0);
  });
});
