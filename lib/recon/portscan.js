// Darknode recon — native TCP connect-scan core (main-process only).
//
// This is the real scanning capability the web console cannot have: a browser
// cannot open an arbitrary TCP socket to an arbitrary host/port. Here we do, in
// the Electron main process, with bounded concurrency and a per-port timeout,
// grabbing a short service banner when one is offered.
//
// Decoupled from Electron so it is unit-testable off a loopback server:
//   scanPorts(host, ports, opts) -> Promise<{ open, hits, cancelled }>
//   opts: {
//     timeout      per-port connect timeout ms (default 900)
//     concurrency  max in-flight sockets (default 250, capped 500)
//     signal       { cancelled } — set .cancelled=true to stop early
//     onHit(port, banner)      called for each open port
//     onProgress(done, total)  called after each probe
//   }
//
// Verified by test/recon/portscan.test.mjs (scans a real loopback listener).

const net = require("net");

function scanPorts(host, ports, opts = {}) {
  const to = opts.timeout || 900;
  const conc = Math.min(opts.concurrency || 250, 500);
  const total = ports.length;
  const state = opts.signal || { cancelled: false };
  const onHit = typeof opts.onHit === "function" ? opts.onHit : () => {};
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  let idx = 0, open = 0;
  const hits = [];

  const probe = (port) => new Promise((res) => {
    const sock = new net.Socket();
    let done = false, banner = "";
    const finish = (isOpen) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch (_) {}
      if (isOpen) {
        open++;
        const b = banner.slice(0, 80);
        hits.push({ port, banner: b });
        onHit(port, b);
      }
      res();
    };
    sock.setTimeout(to);
    sock.once("connect", () => {
      sock.once("data", (d) => {
        banner = d.toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim();
        finish(true);
      });
      setTimeout(() => finish(true), 150);
    });
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  });

  const worker = async () => {
    while (!state.cancelled) {
      const i = idx++;
      if (i >= total) return;
      await probe(ports[i]);
      onProgress(i + 1, total);
    }
  };

  return Promise.all(Array.from({ length: Math.min(conc, total) }, worker))
    .then(() => ({ open, hits, cancelled: state.cancelled }));
}

module.exports = { scanPorts };
