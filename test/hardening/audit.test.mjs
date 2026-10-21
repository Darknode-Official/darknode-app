// Unit tests for lib/hardening-audit.js.
//
// The parsers are pure functions over captured command output, so we feed them
// real sample outputs (the kind the OS commands actually print) and assert the
// verdict. We also test scoring, the exporters, the `na` paths (missing binary),
// and that the runner wires commands to parsers and never throws.
import { test, group, assert } from "../harness.mjs";
import H from "../../lib/hardening-audit.js";

const { parsers, scoreResults, toCSV, toText, toFleetRecord, runAudit } = H;

// Command-result builders matching the shape the runner passes to parsers.
const ok = (stdout, stderr = "", code = 0) => ({ ok: true, code, stdout, stderr });
const missing = () => ({ na: true, reason: "command not found" });
const errored = () => ({ error: "timed out after 8s", code: -1, stdout: "", stderr: "" });

group("audit: disk encryption", () => {
  test("macOS FileVault on -> pass", () => {
    assert.equal(parsers.diskEncryptionMac(ok("FileVault is On.")).status, "pass");
  });
  test("macOS FileVault off -> fail", () => {
    assert.equal(parsers.diskEncryptionMac(ok("FileVault is Off.")).status, "fail");
  });
  test("macOS missing binary -> na", () => {
    assert.equal(parsers.diskEncryptionMac(missing()).status, "na");
  });
  test("Windows BitLocker protection on -> pass", () => {
    assert.equal(parsers.diskEncryptionWindows(ok("Conversion Status: Fully Encrypted\n    Protection Status:  Protection On")).status, "pass");
  });
  test("Windows BitLocker off -> fail", () => {
    assert.equal(parsers.diskEncryptionWindows(ok("Protection Status:  Protection Off")).status, "fail");
  });
  test("Windows Get-BitLockerVolume FullyEncrypted -> pass", () => {
    assert.equal(parsers.diskEncryptionWindows(ok("VolumeStatus : FullyEncrypted")).status, "pass");
  });
  test("Linux lsblk with crypt type -> pass", () => {
    const lsblk = ok("NAME        TYPE  FSTYPE      MOUNTPOINT\nsda         disk\nsda1        part  ext4        /boot\nsda2        part  crypto_LUKS\nroot        crypt ext4        /");
    assert.equal(parsers.diskEncryptionLinux(lsblk, missing()).status, "pass");
  });
  test("Linux lsblk no crypt -> warn", () => {
    const lsblk = ok("NAME TYPE FSTYPE MOUNTPOINT\nsda disk\nsda1 part ext4 /");
    assert.equal(parsers.diskEncryptionLinux(lsblk, missing()).status, "warn");
  });
  test("Linux both missing -> na", () => {
    assert.equal(parsers.diskEncryptionLinux(missing(), missing()).status, "na");
  });
});

group("audit: firewall", () => {
  test("macOS enabled -> pass", () => {
    assert.equal(parsers.firewallMac(ok("Firewall is enabled. (State = 1)")).status, "pass");
  });
  test("macOS disabled -> fail", () => {
    assert.equal(parsers.firewallMac(ok("Firewall is disabled. (State = 0)")).status, "fail");
  });
  test("Windows all profiles ON -> pass", () => {
    const out = "Domain Profile Settings:\nState                                 ON\n\nPrivate Profile Settings:\nState                                 ON\n\nPublic Profile Settings:\nState                                 ON";
    assert.equal(parsers.firewallWindows(ok(out)).status, "pass");
  });
  test("Windows one profile OFF -> warn", () => {
    const out = "State                                 ON\nState                                 OFF\nState                                 ON";
    assert.equal(parsers.firewallWindows(ok(out)).status, "warn");
  });
  test("Linux ufw active -> pass", () => {
    assert.equal(parsers.firewallLinux(ok("Status: active"), missing(), missing(), missing()).status, "pass");
  });
  test("Linux ufw inactive -> fail", () => {
    assert.equal(parsers.firewallLinux(ok("Status: inactive"), missing(), missing(), missing()).status, "fail");
  });
  test("Linux falls back to nft default-drop -> pass", () => {
    const nft = ok("table inet filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy drop;\n\t}\n}");
    assert.equal(parsers.firewallLinux(missing(), missing(), nft, missing()).status, "pass");
  });
  test("Linux firewalld running -> pass", () => {
    assert.equal(parsers.firewallLinux(missing(), ok("running"), missing(), missing()).status, "pass");
  });
  test("Linux nothing available -> na", () => {
    assert.equal(parsers.firewallLinux(missing(), missing(), missing(), missing()).status, "na");
  });
});

group("audit: auto-updates", () => {
  test("macOS check enabled, install enabled -> pass", () => {
    assert.equal(parsers.autoUpdatesMac(ok("1"), ok("1")).status, "pass");
  });
  test("macOS check enabled, install off -> warn", () => {
    assert.equal(parsers.autoUpdatesMac(ok("1"), ok("0")).status, "warn");
  });
  test("macOS check off -> fail", () => {
    assert.equal(parsers.autoUpdatesMac(ok("0"), ok("0")).status, "fail");
  });
  test("Windows wuauserv disabled -> fail", () => {
    assert.equal(parsers.autoUpdatesWindows(ok("START_TYPE         : 4   DISABLED"), missing()).status, "fail");
  });
  test("Windows NoAutoUpdate=1 -> fail", () => {
    assert.equal(parsers.autoUpdatesWindows(ok("START_TYPE : 2 AUTO_START"), ok("NoAutoUpdate    REG_DWORD    0x1")).status, "fail");
  });
  test("Windows normal -> pass", () => {
    assert.equal(parsers.autoUpdatesWindows(ok("START_TYPE : 3 DEMAND_START"), ok("NoAutoUpdate    REG_DWORD    0x0")).status, "pass");
  });
  test("Linux unattended-upgrades on -> pass", () => {
    assert.equal(parsers.autoUpdatesLinux(ok('APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";'), missing()).status, "pass");
  });
  test("Linux dnf-automatic active -> pass", () => {
    assert.equal(parsers.autoUpdatesLinux(missing(), ok("active")).status, "pass");
  });
  test("Linux none -> warn", () => {
    assert.equal(parsers.autoUpdatesLinux(ok(""), ok("inactive")).status, "warn");
  });
});

group("audit: screen lock", () => {
  test("macOS askForPassword=1 + short idle -> pass", () => {
    assert.equal(parsers.screenLockMac(missing(), ok("600"), ok("1")).status, "pass");
  });
  test("macOS idle too long -> fail", () => {
    assert.equal(parsers.screenLockMac(missing(), ok("3600"), ok("1")).status, "fail");
  });
  test("Windows secure + timeout within 15m -> pass", () => {
    assert.equal(parsers.screenLockWindows(ok("ScreenSaveTimeOut    REG_SZ    600"), ok("ScreenSaverIsSecure    REG_SZ    1")).status, "pass");
  });
  test("Windows not secure -> fail", () => {
    assert.equal(parsers.screenLockWindows(ok("ScreenSaveTimeOut    REG_SZ    600"), ok("ScreenSaverIsSecure    REG_SZ    0")).status, "fail");
  });
  test("Linux GNOME lock on + short idle -> pass", () => {
    assert.equal(parsers.screenLockLinuxGnome(ok("true"), ok("uint32 300")).status, "pass");
  });
  test("Linux GNOME lock off -> fail", () => {
    assert.equal(parsers.screenLockLinuxGnome(ok("false"), ok("uint32 300")).status, "fail");
  });
  test("Linux not GNOME -> na", () => {
    assert.equal(parsers.screenLockLinuxGnome(missing(), missing()).status, "na");
  });
});

group("audit: gatekeeper / SIP / defender", () => {
  test("Gatekeeper enabled -> pass", () => {
    assert.equal(parsers.gatekeeperMac(ok("assessments enabled")).status, "pass");
  });
  test("Gatekeeper disabled -> fail", () => {
    assert.equal(parsers.gatekeeperMac(ok("assessments disabled")).status, "fail");
  });
  test("SIP enabled -> pass", () => {
    assert.equal(parsers.sipMac(ok("System Integrity Protection status: enabled.")).status, "pass");
  });
  test("Defender RT+AV on, fresh sigs -> pass", () => {
    assert.equal(parsers.defenderWindows(ok("RealTimeProtectionEnabled : True\nAntivirusEnabled          : True\nAntivirusSignatureAge     : 1")).status, "pass");
  });
  test("Defender stale signatures -> warn", () => {
    assert.equal(parsers.defenderWindows(ok("RealTimeProtectionEnabled : True\nAntivirusEnabled : True\nAntivirusSignatureAge : 30")).status, "warn");
  });
  test("Defender RT off -> fail", () => {
    assert.equal(parsers.defenderWindows(ok("RealTimeProtectionEnabled : False\nAntivirusEnabled : True")).status, "fail");
  });
  test("Linux EDR found -> pass", () => {
    assert.equal(parsers.edrLinux(ok("systemd\nfalcon-sensor\nbash")).status, "pass");
  });
  test("Linux no EDR -> warn (heuristic)", () => {
    assert.equal(parsers.edrLinux(ok("systemd\nbash\nsshd")).status, "warn");
  });
});

group("audit: sshd hardening", () => {
  test("hardened config -> pass", () => {
    const out = "permitrootlogin no\npasswordauthentication no\nmaxauthtries 4\nx11forwarding no";
    assert.equal(parsers.sshd(ok(out)).status, "pass");
  });
  test("root login + password auth -> fail", () => {
    const out = "permitrootlogin yes\npasswordauthentication yes\nmaxauthtries 6\nx11forwarding yes";
    const v = parsers.sshd(ok(out));
    assert.equal(v.status, "fail");
    assert.ok(/PermitRootLogin/.test(v.evidence));
  });
  test("prohibit-password accepted -> pass", () => {
    const out = "permitrootlogin prohibit-password\npasswordauthentication no\nmaxauthtries 3\nx11forwarding no";
    assert.equal(parsers.sshd(ok(out)).status, "pass");
  });
  test("no sshd -> na", () => {
    assert.equal(parsers.sshd(missing()).status, "na");
  });
});

group("audit: accounts", () => {
  test("Windows guest disabled -> pass", () => {
    assert.equal(parsers.guestWindows(ok("User name  Guest\nAccount active   No")).status, "pass");
  });
  test("Windows guest active -> fail", () => {
    assert.equal(parsers.guestWindows(ok("Account active   Yes")).status, "fail");
  });
  test("macOS guest enabled -> fail", () => {
    assert.equal(parsers.guestMac(ok("1")).status, "fail");
  });
  test("macOS guest disabled -> pass", () => {
    assert.equal(parsers.guestMac(ok("0")).status, "pass");
  });
  test("Windows password policy weak length -> warn", () => {
    assert.equal(parsers.passwordPolicyWindows(ok("Minimum password length:    6\nLockout threshold:    Never")).status, "warn");
  });
  test("Windows password policy ok -> pass", () => {
    assert.equal(parsers.passwordPolicyWindows(ok("Minimum password length:    14\nLockout threshold:    5")).status, "pass");
  });
  test("Linux PASS_MAX_DAYS within policy -> pass", () => {
    assert.equal(parsers.passwordPolicyLinux(ok("# comment\nPASS_MAX_DAYS   365\nPASS_MIN_DAYS   1")).status, "pass");
  });
  test("Linux admin count small -> pass", () => {
    assert.equal(parsers.adminCountLinux(ok("sudo:x:27:alice")).status, "pass");
  });
  test("Linux admin count large -> warn", () => {
    assert.equal(parsers.adminCountLinux(ok("sudo:x:27:a,b,c,d,e")).status, "warn");
  });
});

group("audit: listening services", () => {
  test("risky RDP on wildcard -> warn with process", () => {
    const out = 'State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port Process\nLISTEN 0      128     0.0.0.0:3389        0.0.0.0:*         users:(("xrdp",pid=900,fd=7))';
    const v = parsers.listeningServices(ok(out));
    assert.equal(v.status, "warn");
    assert.ok(/RDP/.test(v.evidence));
    assert.ok(/xrdp/.test(v.evidence));
  });
  test("only localhost binds -> pass", () => {
    const out = "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:631 0.0.0.0:*";
    assert.equal(parsers.listeningServices(ok(out)).status, "pass");
  });
  test("no listeners -> pass", () => {
    assert.equal(parsers.listeningServices(ok("")).status, "pass");
  });
});

group("audit: remote access", () => {
  test("Windows RDP denied -> pass", () => {
    assert.equal(parsers.remoteAccessWindows(ok("fDenyTSConnections    REG_DWORD    0x1")).status, "pass");
  });
  test("Windows RDP allowed -> warn", () => {
    assert.equal(parsers.remoteAccessWindows(ok("fDenyTSConnections    REG_DWORD    0x0")).status, "warn");
  });
  test("macOS remote login on -> warn", () => {
    assert.equal(parsers.remoteLoginMac(ok("Remote Login: On"), null).status, "warn");
  });
  test("Linux xrdp running -> warn", () => {
    assert.equal(parsers.remoteAccessLinux(ok("systemd\nxrdp\nbash")).status, "warn");
  });
  test("Linux no remote svc -> pass", () => {
    assert.equal(parsers.remoteAccessLinux(ok("systemd\nbash")).status, "pass");
  });
});

group("audit: time sync and secure boot", () => {
  test("Linux clock synced -> pass", () => {
    assert.equal(parsers.timeSyncLinux(ok("System clock synchronized: yes\nNTP service: active")).status, "pass");
  });
  test("Linux clock not synced -> warn", () => {
    assert.equal(parsers.timeSyncLinux(ok("System clock synchronized: no\nNTP service: inactive")).status, "warn");
  });
  test("Linux secure boot enabled -> pass", () => {
    assert.equal(parsers.secureBootLinux(ok("SecureBoot enabled")).status, "pass");
  });
  test("Linux secure boot unsupported -> na", () => {
    assert.equal(parsers.secureBootLinux(ok("EFI variables are not supported on this system")).status, "na");
  });
  test("Windows secure boot True -> pass", () => {
    assert.equal(parsers.secureBootWindows(ok("True")).status, "pass");
  });
});

group("audit: persistence inventory", () => {
  test("entries -> warn (review)", () => {
    assert.equal(parsers.persistenceInventory(ok("com.example.agent.plist\ncom.other.plist"), "launch items").status, "warn");
  });
  test("no entries -> pass", () => {
    assert.equal(parsers.persistenceInventory(ok(""), "launch items").status, "pass");
  });
});

group("audit: scoring", () => {
  test("weights by severity, excludes na/error", () => {
    const results = [
      { status: "pass", severity: "high" },   // 3/3
      { status: "fail", severity: "high" },   // 0/3
      { status: "warn", severity: "medium" }, // 1/2
      { status: "na", severity: "low" },      // excluded
      { status: "error", severity: "low" },   // excluded
    ];
    const s = scoreResults(results);
    assert.equal(s.possible, 8);           // 3 + 3 + 2
    assert.equal(s.earned, 4);             // 3 + 0 + 1
    assert.equal(s.percent, 50);
    assert.equal(s.counts.pass, 1);
    assert.equal(s.counts.na, 1);
    assert.equal(s.counts.error, 1);
  });
  test("all na -> percent null", () => {
    const s = scoreResults([{ status: "na", severity: "high" }]);
    assert.equal(s.percent, null);
    assert.equal(s.grade, "n/a");
  });
});

group("audit: exporters", () => {
  const report = {
    host: "host-1", os: "Ubuntu 24.04", generated: "2026-01-01T00:00:00.000Z", appVersion: "2.51.0",
    score: { percent: 50, grade: "F", earned: 4, possible: 8, counts: { pass: 1, fail: 1, warn: 1, na: 1, error: 0, total: 4 } },
    results: [
      { id: "firewall", title: "Host firewall", cisRef: "CIS Ubuntu 3.5.x", status: "fail", severity: "high", category: "linux", evidence: "Status: inactive", fix: "Enable ufw: sudo ufw enable" },
      { id: "disk-encryption", title: "Disk, encryption", cisRef: "CIS Ubuntu 1.1.x", status: "pass", severity: "high", category: "linux", evidence: "crypt present", fix: "ok" },
    ],
  };
  test("CSV has header + quotes cells with commas", () => {
    const csv = toCSV(report);
    const lines = csv.split("\n");
    assert.equal(lines[0], "id,title,cisRef,status,severity,category,evidence,fix");
    assert.ok(csv.includes('"Disk, encryption"'));
  });
  test("CSV neutralizes spreadsheet formula injection in evidence/fix", () => {
    const rep = { results: [{ id: "x", title: "t", cisRef: "c", status: "fail", severity: "high", category: "linux", evidence: "=cmd|'/C calc'!A1", fix: "@SUM(1,1)" }] };
    const row = toCSV(rep).split("\n")[1];
    for (const cell of row.split(",")) assert.ok(!/^[=+\-@]/.test(cell.replace(/^"/, "")), `cell must not start a formula: ${cell}`);
    assert.ok(row.includes("'=cmd") && row.includes("'@SUM"), "formulas must be quote-prefixed");
  });
  test("a lone CR in a cell is collapsed (not an unquoted row break)", () => {
    const rep = { results: [{ id: "x", title: "ok\rinjected", cisRef: "c", status: "fail", severity: "high", category: "linux", evidence: "e", fix: "f" }] };
    const csv = toCSV(rep);
    assert.equal(csv.split("\n").length, 2, "header + exactly one data row");
    assert.notOk(/\r/.test(csv), "no raw CR may survive in the output");
    assert.ok(csv.includes("ok injected"), "the CR becomes a space");
  });
  test("text report has header, score, and a FAIL line", () => {
    const txt = toText(report);
    assert.ok(txt.includes("WORKSTATION SECURITY AUDIT"));
    assert.ok(txt.includes("50% (F)"));
    assert.ok(/\[FAIL\] Host firewall/.test(txt));
  });
  test("fleet record drops evidence, keeps ids/status", () => {
    const fr = toFleetRecord(report);
    assert.equal(fr.host, "host-1");
    assert.equal(fr.results.length, 2);
    assert.equal(fr.results[0].evidence, undefined);
    assert.ok(fr.results[0].id && fr.results[0].status);
  });
});

group("audit: runner wiring", () => {
  test("linux run produces a result per check, honest na for missing bins", async () => {
    const exec = async (bin) => {
      if (bin === "lsblk") return ok("NAME TYPE FSTYPE MOUNTPOINT\nroot crypt ext4 /");
      if (bin === "ufw") return ok("Status: active");
      return missing();
    };
    const rep = await runAudit({ platform: "linux", exec, host: "h", osDescription: "Linux" });
    assert.ok(rep.results.length >= 10);
    const fw = rep.results.find((r) => r.id === "firewall");
    assert.equal(fw.status, "pass");
    const disk = rep.results.find((r) => r.id === "disk-encryption");
    assert.equal(disk.status, "pass");
    // a check whose binary is missing must be na, never a fabricated verdict
    const tsync = rep.results.find((r) => r.id === "time-sync");
    assert.equal(tsync.status, "na");
    assert.ok(rep.score);
  });
  test("a throwing exec is contained as an error result, not a crash", async () => {
    const exec = async () => { throw new Error("boom"); };
    const rep = await runAudit({ platform: "linux", exec });
    assert.ok(rep.results.every((r) => ["pass", "fail", "warn", "na", "error"].includes(r.status)));
    assert.ok(rep.results.some((r) => r.status === "error"));
  });
  test("runAudit requires an exec function", async () => {
    let threw = false;
    try { await runAudit({ platform: "linux" }); } catch (_) { threw = true; }
    assert.ok(threw);
  });
});
