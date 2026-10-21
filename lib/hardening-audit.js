"use strict";
// Workstation Security Audit — CIS Benchmark Level 1 style checks for the local
// machine the app runs on.
//
// Design goals that this module is built to satisfy:
//   * REAL or nothing. A check either runs an actual OS command and parses its
//     real output, or it reports `na` / `error` with the reason. There are no
//     simulated verdicts anywhere in here.
//   * READ-ONLY. Every command listed is a status/query command. Nothing in this
//     module modifies system state, and the runner never escalates privileges —
//     if a check needs root it reports `na` with reason "needs-elevation".
//   * TESTABLE. The output-parsing logic is split into pure functions
//     (`parsers.*`) that take a captured command result and return a verdict.
//     The runner only wires fixed commands to those parsers. Unit tests feed the
//     parsers captured sample outputs (see test/hardening/*).
//
// A command result passed to a parser has the shape:
//   { ok:boolean, code:number|null, stdout:string, stderr:string,
//     error?:string, na?:boolean, reason?:string, cmd?:string }
// `na:true` means the command could not be run at all (binary missing / not
// applicable on this OS); parsers surface that as an `na` verdict.
//
// A check result has the shape required by the feature spec:
//   { id, title, cisRef, status:"pass"|"fail"|"warn"|"na"|"error",
//     evidence, fix, severity:"high"|"medium"|"low", category }

const SEV = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

// --- small helpers -------------------------------------------------------

function trimEvidence(s, max) {
  s = String(s == null ? "" : s).replace(/\r\n/g, "\n").trim();
  max = max || 600;
  return s.length > max ? s.slice(0, max) + "\n… (truncated)" : s;
}

// Did the command actually run and produce usable output?
function ran(r) {
  return !!r && !r.na && !r.error && r.code !== -1;
}

// Build an `na` verdict from a command result, preserving the reason.
function naVerdict(r, fallbackFix) {
  const reason = (r && (r.reason || r.error)) || "not checkable on this system";
  return { status: "na", evidence: reason, fix: fallbackFix || "Not applicable / not checkable on this host." };
}

// =========================================================================
// PURE PARSERS — each takes a command result (or a couple of them) and returns
// { status, evidence, fix }. These are the unit-tested units.
// =========================================================================

const parsers = {
  // ---- Disk encryption --------------------------------------------------
  diskEncryptionMac(r) {
    if (!ran(r)) return naVerdict(r, "Run `fdesetup status` in Terminal to check FileVault.");
    const out = (r.stdout || "") + (r.stderr || "");
    const on = /FileVault is On/i.test(out);
    return {
      status: on ? "pass" : "fail",
      evidence: trimEvidence(out),
      fix: on ? "FileVault is enabled." : "Enable FileVault: System Settings → Privacy & Security → FileVault → Turn On. Store the recovery key with IT.",
    };
  },
  diskEncryptionWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `manage-bde -status` as Administrator.");
    const out = (r.stdout || "") + (r.stderr || "");
    // Get-BitLockerVolume VolumeStatus / manage-bde "Protection Status"
    const protectionOn = /Protection Status:\s*Protection On/i.test(out) || /VolumeStatus\s*:?\s*FullyEncrypted/i.test(out) || /Percentage Encrypted:\s*100/i.test(out);
    const protectionOff = /Protection Status:\s*Protection Off/i.test(out) || /VolumeStatus\s*:?\s*FullyDecrypted/i.test(out) || /FullyDecrypted/i.test(out);
    // Check OFF first: a suspended BitLocker volume reports "Protection Off" AND
    // "Percentage Encrypted: 100" / "FullyEncrypted" (the key is escrowed in the
    // clear), so testing protectionOn first would mis-grade a suspended, effectively
    // unprotected disk as "pass" — a disk-encryption false negative.
    let status = "warn";
    if (protectionOff) status = "fail";
    else if (protectionOn) status = "pass";
    return {
      status,
      evidence: trimEvidence(out),
      fix: status === "pass" ? "BitLocker protection is on for the OS volume." : "Enable BitLocker on the OS drive: Control Panel → BitLocker Drive Encryption → Turn on BitLocker. Back up the recovery key.",
    };
  },
  diskEncryptionLinux(lsblk, dmsetup) {
    const lsRan = ran(lsblk), dmRan = ran(dmsetup);
    if (!lsRan && !dmRan) return naVerdict(lsblk, "Run `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT` to inspect block devices.");
    const lsOut = lsRan ? (lsblk.stdout || "") : "";
    const dmOut = dmRan ? (dmsetup.stdout || "") : "";
    // A LUKS/crypt mapping shows TYPE=crypt in lsblk or an active target in dmsetup.
    const hasCrypt = /\bcrypt\b/.test(lsOut) || /crypt_LUKS|LUKS/i.test(lsOut) || (dmRan && /:\s*0\s+\d+\s+crypt\b/i.test(dmOut));
    const rootEncrypted = hasCrypt; // best-effort: a crypt mapping is present on the device tree
    const evidence = trimEvidence([lsOut && "lsblk:\n" + lsOut, dmOut && "dmsetup status:\n" + dmOut].filter(Boolean).join("\n\n"));
    return {
      status: rootEncrypted ? "pass" : "warn",
      evidence,
      fix: rootEncrypted
        ? "A LUKS/dm-crypt mapping is present. Confirm it covers the root/data filesystems."
        : "No dm-crypt/LUKS mapping detected. Full-disk encryption (LUKS) must be set up at install time; existing systems need a reinstall or an in-place `cryptsetup reencrypt`. Verify whether self-encrypting-drive hardware is in use.",
    };
  },

  // ---- Host firewall ----------------------------------------------------
  firewallMac(r) {
    if (!ran(r)) return naVerdict(r, "Check: /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate");
    const out = (r.stdout || "") + (r.stderr || "");
    const enabled = /Firewall is enabled/i.test(out) || /state\s*=\s*1/i.test(out);
    return {
      status: enabled ? "pass" : "fail",
      evidence: trimEvidence(out),
      fix: enabled ? "Application Firewall is enabled." : "Enable the firewall: System Settings → Network → Firewall → On (or `socketfilterfw --setglobalstate on`).",
    };
  },
  firewallWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `netsh advfirewall show allprofiles state`.");
    const out = (r.stdout || "") + (r.stderr || "");
    // netsh prints a "State ON/OFF" line per profile; Get-NetFirewallProfile prints Enabled True/False.
    const states = (out.match(/State\s+(ON|OFF)/gi) || []).map((s) => /ON/i.test(s));
    const enabledFlags = (out.match(/Enabled\s*:?\s*(True|False)/gi) || []).map((s) => /True/i.test(s));
    const all = states.concat(enabledFlags);
    let status = "na";
    if (all.length) status = all.every(Boolean) ? "pass" : (all.some(Boolean) ? "warn" : "fail");
    return {
      status,
      evidence: trimEvidence(out),
      fix: status === "pass" ? "All firewall profiles are on." : "Enable Windows Firewall for every profile: `netsh advfirewall set allprofiles state on`.",
    };
  },
  firewallLinux(ufw, firewalld, nft, iptables) {
    // Try each backend in turn; the first that actually ran wins.
    if (ran(ufw)) {
      const out = ufw.stdout || "";
      const active = /Status:\s*active/i.test(out);
      return { status: active ? "pass" : "fail", evidence: trimEvidence(out), fix: active ? "ufw is active." : "Enable ufw: `sudo ufw enable` (set a default-deny inbound policy first)." };
    }
    if (ran(firewalld)) {
      const out = (firewalld.stdout || "").trim();
      const running = /running/i.test(out);
      return { status: running ? "pass" : "fail", evidence: trimEvidence(out || firewalld.stderr), fix: running ? "firewalld is running." : "Start firewalld: `sudo systemctl enable --now firewalld`." };
    }
    if (ran(nft)) {
      const out = nft.stdout || "";
      const hasRules = /\btable\b/.test(out) && /\bchain\b/.test(out);
      const defaultDrop = /policy\s+drop/i.test(out);
      let status = "warn";
      if (hasRules && defaultDrop) status = "pass";
      else if (!hasRules) status = "fail";
      return { status, evidence: trimEvidence(out || "(empty ruleset)"), fix: status === "pass" ? "nftables has rules with a default-drop policy." : "No default-drop firewall ruleset found. Configure nftables/ufw/firewalld with a default-deny inbound policy." };
    }
    if (ran(iptables)) {
      const out = iptables.stdout || "";
      const inputDrop = /-P INPUT (DROP|REJECT)/i.test(out);
      return { status: inputDrop ? "pass" : "fail", evidence: trimEvidence(out), fix: inputDrop ? "iptables INPUT policy is DROP/REJECT." : "Set a default-deny inbound policy (ufw/firewalld/nftables preferred over raw iptables)." };
    }
    return naVerdict(ufw, "Install/enable a host firewall (ufw, firewalld, or nftables) and check its status.");
  },

  // ---- OS automatic updates --------------------------------------------
  autoUpdatesMac(check, install) {
    if (!ran(check)) return naVerdict(check, "Check `defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled`.");
    const chk = (check.stdout || "").trim();
    const inst = ran(install) ? (install.stdout || "").trim() : null;
    const checkOn = chk === "1";
    const instOn = inst === "1";
    let status = checkOn ? "pass" : "fail";
    if (checkOn && inst != null && !instOn) status = "warn";
    return {
      status,
      evidence: trimEvidence("AutomaticCheckEnabled=" + chk + (inst != null ? "\nAutomaticallyInstallMacOSUpdates=" + inst : "")),
      fix: status === "pass" ? "Automatic update checks are enabled." : "System Settings → General → Software Update → Automatic Updates: turn on checking, downloading and installing of security responses and system files.",
    };
  },
  autoUpdatesWindows(svc, reg) {
    const svcRan = ran(svc), regRan = ran(reg);
    if (!svcRan && !regRan) return naVerdict(svc, "Check the Windows Update service (wuauserv) and the AU policy.");
    const svcOut = svcRan ? (svc.stdout || "") : "";
    const regOut = regRan ? (reg.stdout || "") : "";
    // wuauserv not Disabled, and NoAutoUpdate not = 1
    const svcDisabled = /StartType\s*:?\s*Disabled/i.test(svcOut) || /START_TYPE\s*:\s*4\s*DISABLED/i.test(svcOut);
    const noAuto = /NoAutoUpdate\s+REG_DWORD\s+0x1/i.test(regOut) || /NoAutoUpdate\s*:?\s*1\b/i.test(regOut);
    let status = "pass";
    if (svcDisabled || noAuto) status = "fail";
    return {
      status,
      evidence: trimEvidence([svcOut && "wuauserv:\n" + svcOut, regOut && "AU policy:\n" + regOut].filter(Boolean).join("\n\n")),
      fix: status === "pass" ? "Windows Update is not disabled." : "Re-enable automatic updates: set wuauserv to Automatic and remove the NoAutoUpdate policy (`HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU`).",
    };
  },
  autoUpdatesLinux(unattended, dnfTimer) {
    const uRan = ran(unattended), dRan = ran(dnfTimer);
    if (!uRan && !dRan) return naVerdict(unattended, "Check for unattended-upgrades (Debian/Ubuntu) or the dnf-automatic timer (RHEL/Fedora).");
    const uOut = uRan ? ((unattended.stdout || "") + (unattended.stderr || "")) : "";
    const dOut = dRan ? ((dnfTimer.stdout || "") + (dnfTimer.stderr || "")) : "";
    // apt config: Unattended-Upgrade "1"; or dnf-automatic timer active/enabled
    const aptOn = /Update-Package-Lists\s+"1"/i.test(uOut) || /Unattended-Upgrade\s+"1"/i.test(uOut);
    const dnfOn = /\bactive\b/i.test(dOut) || /enabled/i.test(dOut);
    const on = aptOn || dnfOn;
    return {
      status: on ? "pass" : "warn",
      evidence: trimEvidence([uOut && "unattended-upgrades:\n" + uOut, dOut && "dnf-automatic.timer:\n" + dOut].filter(Boolean).join("\n\n") || "no auto-update mechanism found"),
      fix: on ? "An automatic-update mechanism is configured." : "Enable automatic security updates: Debian/Ubuntu `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`; RHEL/Fedora `sudo systemctl enable --now dnf-automatic.timer`.",
    };
  },

  // ---- Screen lock / idle timeout --------------------------------------
  screenLockMac(ask, idle, secure) {
    const parts = [];
    let locked = null, delay = null;
    if (ran(ask)) { const o = (ask.stdout || "") + (ask.stderr || ""); parts.push("sysadminctl:\n" + o.trim()); if (/screenLock.*on|is on/i.test(o)) locked = true; }
    if (ran(idle)) { const o = (idle.stdout || "").trim(); parts.push("idleTime=" + o); if (/^\d+$/.test(o)) delay = parseInt(o, 10); }
    if (ran(secure)) { const o = (secure.stdout || "").trim(); parts.push("askForPassword=" + o); if (o === "1") locked = true; else if (o === "0") locked = false; }
    if (!parts.length) return naVerdict(ask, "Check `defaults -currentHost read com.apple.screensaver idleTime` and askForPassword.");
    let status = "warn";
    if (delay != null) status = (delay > 0 && delay <= 900 && locked !== false) ? "pass" : "fail";
    else if (locked === true) status = "pass";
    else if (locked === false) status = "fail";
    return {
      status,
      evidence: trimEvidence(parts.join("\n")),
      fix: status === "pass" ? "Screen locks after an idle period." : "Set the screen to lock on sleep/saver within 15 minutes: System Settings → Lock Screen → require password immediately after screen saver; idle ≤ 900s.",
    };
  },
  screenLockWindows(timeout, secure) {
    const tRan = ran(timeout), sRan = ran(secure);
    if (!tRan && !sRan) return naVerdict(timeout, "Check registry ScreenSaveTimeOut and ScreenSaverIsSecure.");
    const tOut = tRan ? (timeout.stdout || "") : "";
    const sOut = sRan ? (secure.stdout || "") : "";
    const tm = tOut.match(/ScreenSaveTimeOut\s+REG_SZ\s+(\d+)/i) || tOut.match(/ScreenSaveTimeOut\s*:?\s*(\d+)/i);
    const secureOn = /ScreenSaverIsSecure\s+REG_SZ\s+1/i.test(sOut) || /ScreenSaverIsSecure\s*:?\s*1\b/i.test(sOut);
    const secs = tm ? parseInt(tm[1], 10) : null;
    let status = "warn";
    if (secs != null) status = (secs > 0 && secs <= 900 && secureOn) ? "pass" : "fail";
    else if (secureOn) status = "warn";
    return {
      status,
      evidence: trimEvidence([tOut, sOut].filter(Boolean).join("\n")),
      fix: status === "pass" ? "A password-protected screen saver locks within 15 minutes." : "Set a password-protected screen saver with a ≤15-minute timeout via Group Policy or Settings → Accounts → Sign-in options.",
    };
  },
  screenLockLinuxGnome(enabled, idle) {
    const eRan = ran(enabled), iRan = ran(idle);
    if (!eRan && !iRan) return naVerdict(enabled, "Not a GNOME session, or gsettings unavailable.");
    const eOut = (eRan ? enabled.stdout : "").trim();
    const iOut = (iRan ? idle.stdout : "").trim();
    const lockOn = /true/i.test(eOut);
    const idleM = iOut.match(/(\d+)/);
    const idleSecs = idleM ? parseInt(idleM[1], 10) : null;
    let status = "warn";
    if (lockOn && idleSecs != null) status = (idleSecs > 0 && idleSecs <= 900) ? "pass" : "fail";
    else if (lockOn) status = "pass";
    else status = "fail";
    return {
      status,
      evidence: trimEvidence("lock-enabled=" + eOut + "\nidle-delay=" + iOut),
      fix: status === "pass" ? "GNOME screen lock is enabled with an idle delay." : "Enable GNOME screen lock: `gsettings set org.gnome.desktop.screensaver lock-enabled true` and set `org.gnome.desktop.session idle-delay` to ≤900.",
    };
  },

  // ---- macOS Gatekeeper / SIP ------------------------------------------
  gatekeeperMac(r) {
    if (!ran(r)) return naVerdict(r, "Run `spctl --status`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const on = /assessments enabled/i.test(out);
    return { status: on ? "pass" : "fail", evidence: trimEvidence(out), fix: on ? "Gatekeeper is enabled." : "Enable Gatekeeper: `sudo spctl --master-enable`." };
  },
  sipMac(r) {
    if (!ran(r)) return naVerdict(r, "Run `csrutil status`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const on = /System Integrity Protection status:\s*enabled/i.test(out) || /status:\s*enabled/i.test(out);
    return { status: on ? "pass" : "fail", evidence: trimEvidence(out), fix: on ? "System Integrity Protection is enabled." : "Enable SIP from Recovery: boot to Recovery → Terminal → `csrutil enable`." };
  },

  // ---- Windows Defender -------------------------------------------------
  defenderWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `Get-MpComputerStatus`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const rt = /RealTimeProtectionEnabled\s*:?\s*True/i.test(out);
    const av = /AntivirusEnabled\s*:?\s*True/i.test(out);
    const ageM = out.match(/AntivirusSignatureAge\s*:?\s*(\d+)/i);
    const age = ageM ? parseInt(ageM[1], 10) : null;
    let status = (rt && av) ? "pass" : "fail";
    if (status === "pass" && age != null && age > 7) status = "warn";
    return {
      status,
      evidence: trimEvidence(out),
      fix: status === "pass" ? "Microsoft Defender real-time protection is on." : "Enable real-time protection in Windows Security, or confirm a third-party AV is registered and current. Update signatures if older than 7 days.",
    };
  },

  // ---- Linux EDR/AV presence (heuristic) --------------------------------
  edrLinux(r) {
    if (!ran(r)) return naVerdict(r, "Check running processes for an EDR/AV agent.");
    const out = r.stdout || "";
    const agents = ["falcon-sensor", "falconctl", "clamd", "freshclam", "s1agent", "SentinelAgent", "wazuh-agent", "ossec", "mdatp", "sophos"];
    const found = agents.filter((a) => out.toLowerCase().includes(a.toLowerCase()));
    return {
      status: found.length ? "pass" : "warn",
      evidence: trimEvidence(found.length ? "Detected agent process(es): " + found.join(", ") : "No known EDR/AV agent process detected (heuristic — a renamed or unlisted agent would be missed)."),
      fix: found.length ? "An endpoint-protection agent appears to be running (heuristic)." : "If this machine is in scope for endpoint protection, confirm the agent (CrowdStrike, SentinelOne, Defender for Endpoint, Wazuh, ClamAV, etc.) is installed and running. This is a heuristic process check.",
    };
  },

  // ---- SSH daemon hardening --------------------------------------------
  sshd(r) {
    if (!ran(r)) return naVerdict(r, "No sshd, or `sshd -T` not runnable without root — review /etc/ssh/sshd_config manually.");
    const out = (r.stdout || "").toLowerCase();
    if (!out.trim()) return naVerdict(r, "sshd produced no effective config.");
    const get = (k) => { const m = out.match(new RegExp("^" + k + "\\s+(.+)$", "im")); return m ? m[1].trim() : null; };
    const findings = [];
    const permitRoot = get("permitrootlogin");
    const passAuth = get("passwordauthentication");
    const maxAuth = get("maxauthtries");
    const x11 = get("x11forwarding");
    if (permitRoot && permitRoot !== "no" && permitRoot !== "prohibit-password") findings.push("PermitRootLogin=" + permitRoot + " (should be no)");
    if (passAuth === "yes") findings.push("PasswordAuthentication=yes (key-based auth preferred)");
    if (maxAuth && parseInt(maxAuth, 10) > 4) findings.push("MaxAuthTries=" + maxAuth + " (recommend ≤4)");
    if (x11 === "yes") findings.push("X11Forwarding=yes (disable unless needed)");
    const ev = ["PermitRootLogin=" + permitRoot, "PasswordAuthentication=" + passAuth, "MaxAuthTries=" + maxAuth, "X11Forwarding=" + x11].join("\n");
    return {
      status: findings.length ? "fail" : "pass",
      evidence: trimEvidence(ev + (findings.length ? "\n\nIssues: " + findings.join("; ") : "")),
      fix: findings.length ? "Harden /etc/ssh/sshd_config: PermitRootLogin no; PasswordAuthentication no; MaxAuthTries 4; X11Forwarding no — then `sudo systemctl reload sshd`." : "sshd is hardened (no root login, key auth, limited retries, no X11 forwarding).",
    };
  },

  // ---- Guest account ----------------------------------------------------
  guestMac(r) {
    if (!ran(r)) return naVerdict(r, "Run `sysadminctl -guestAccount status` or `defaults read /Library/Preferences/com.apple.loginwindow GuestEnabled`.");
    const out = (r.stdout || "") + (r.stderr || "");
    // GuestEnabled: 0 good; sysadminctl prints "guest account is Off"
    const off = /GuestEnabled\s*=?\s*0/i.test(out) || /guest account is Off/i.test(out) || out.trim() === "0";
    const on = /GuestEnabled\s*=?\s*1/i.test(out) || /guest account is On/i.test(out) || out.trim() === "1";
    let status = "warn";
    if (off) status = "pass"; else if (on) status = "fail";
    return { status, evidence: trimEvidence(out), fix: status === "pass" ? "Guest account is disabled." : "Disable the guest account: System Settings → Users & Groups → Guest User → off." };
  },
  guestWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `net user guest`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const active = out.match(/Account active\s+(Yes|No)/i);
    let status = "warn";
    if (active) status = /No/i.test(active[1]) ? "pass" : "fail";
    return { status, evidence: trimEvidence(out), fix: status === "pass" ? "The built-in Guest account is disabled." : "Disable the Guest account: `net user guest /active:no`." };
  },

  // ---- Password / lockout policy ---------------------------------------
  passwordPolicyWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `net accounts`.");
    const out = r.stdout || "";
    const minLen = (out.match(/Minimum password length\s*:?\s*(\d+)/i) || [])[1];
    const maxAge = (out.match(/Maximum password age \(days\)\s*:?\s*(\d+|Unlimited)/i) || [])[1];
    const lockout = (out.match(/Lockout threshold\s*:?\s*(\d+|Never)/i) || [])[1];
    const issues = [];
    if (minLen != null && parseInt(minLen, 10) < 14) issues.push("min length " + minLen + " (<14)");
    if (lockout != null && /never/i.test(lockout)) issues.push("no account-lockout threshold");
    return {
      status: issues.length ? "warn" : (minLen != null ? "pass" : "na"),
      evidence: trimEvidence(out),
      fix: issues.length ? "Strengthen local policy: minimum length ≥14 and an account-lockout threshold (e.g. 5). Set via `net accounts` or Group Policy." : "Local password policy meets the baseline length and lockout settings.",
    };
  },
  passwordPolicyLinux(r) {
    if (!ran(r)) return naVerdict(r, "Read PASS_MAX_DAYS from /etc/login.defs.");
    const out = r.stdout || "";
    const m = out.match(/^\s*PASS_MAX_DAYS\s+(\d+)/im);
    if (!m) return { status: "warn", evidence: trimEvidence(out || "PASS_MAX_DAYS not set"), fix: "Set PASS_MAX_DAYS (e.g. 365) in /etc/login.defs and apply to existing users with `chage`." };
    const days = parseInt(m[1], 10);
    const ok = days > 0 && days <= 365;
    return { status: ok ? "pass" : "warn", evidence: trimEvidence("PASS_MAX_DAYS=" + days), fix: ok ? "Password maximum age is set within policy." : "Set PASS_MAX_DAYS to a finite value ≤365 in /etc/login.defs." };
  },

  // ---- Admin / sudo membership -----------------------------------------
  adminCountLinux(r) {
    if (!ran(r)) return naVerdict(r, "Inspect the sudo/wheel group membership in /etc/group.");
    const out = (r.stdout || "").trim();
    // expected: "sudo:x:27:user1,user2" style line(s)
    const members = new Set();
    for (const line of out.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 4 && parts[3]) parts[3].split(",").forEach((u) => u.trim() && members.add(u.trim()));
    }
    const n = members.size;
    return {
      status: n === 0 ? "na" : (n <= 3 ? "pass" : "warn"),
      evidence: trimEvidence(out + "\n\nAdmin/sudo members: " + (n ? [...members].join(", ") : "(none listed in group file; may use sudoers rules)")),
      fix: n > 3 ? "Review who holds admin rights (" + n + " accounts). Remove standing admin from day-to-day user accounts; grant via just-in-time elevation." : "Administrative group membership is limited.",
    };
  },

  // ---- Listening services ----------------------------------------------
  listeningServices(r) {
    if (!ran(r)) return naVerdict(r, "Run `ss -tulpn` (Linux), `netstat -ano` (Windows) or `lsof -iTCP -sTCP:LISTEN` (macOS).");
    const out = r.stdout || "";
    const risky = { 21: "FTP", 23: "Telnet", 445: "SMB", 3389: "RDP", 5900: "VNC", 1433: "MSSQL", 3306: "MySQL", 5432: "PostgreSQL", 27017: "MongoDB", 6379: "Redis", 9200: "Elasticsearch" };
    const exposed = [];
    for (const line of out.split("\n")) {
      // match an address:port bound to a wildcard (0.0.0.0, ::, *) in LISTEN state
      const m = line.match(/(?:0\.0\.0\.0|\*|\[::\]|::):(\d{1,5})\b/);
      if (!m) continue;
      const port = parseInt(m[1], 10);
      if (risky[port]) {
        const procM = line.match(/users:\(\("([^"]+)"/) || line.match(/\d+\/(\S+)\s*$/) || line.match(/\s(\d+)\s*$/);
        exposed.push(risky[port] + " :" + port + (procM ? " (" + procM[1] + ")" : ""));
      }
    }
    return {
      status: exposed.length ? "warn" : "pass",
      evidence: trimEvidence(exposed.length ? "Risky services listening on all interfaces:\n" + exposed.join("\n") + "\n\n--- full listener list ---\n" + out : out || "(no listeners)"),
      fix: exposed.length ? "Restrict or disable these externally-reachable services: " + exposed.join(", ") + ". Bind them to localhost or put them behind the firewall/VPN." : "No high-risk services are listening on all interfaces.",
    };
  },

  // ---- Remote access ----------------------------------------------------
  remoteAccessWindows(r) {
    if (!ran(r)) return naVerdict(r, "Check fDenyTSConnections (RDP) in the registry.");
    const out = r.stdout || "";
    const deny = /fDenyTSConnections\s+REG_DWORD\s+0x1/i.test(out) || /fDenyTSConnections\s*:?\s*1\b/i.test(out);
    const allow = /fDenyTSConnections\s+REG_DWORD\s+0x0/i.test(out) || /fDenyTSConnections\s*:?\s*0\b/i.test(out);
    let status = "na";
    if (deny) status = "pass"; else if (allow) status = "warn";
    return { status, evidence: trimEvidence(out), fix: status === "pass" ? "RDP is disabled." : "If RDP is not required, disable it (System → Remote Desktop → Off). If required, restrict it to a VPN and require Network Level Authentication." };
  },
  remoteLoginMac(ssh, screen) {
    const sRan = ran(ssh), scRan = ran(screen);
    if (!sRan && !scRan) return naVerdict(ssh, "Run `systemsetup -getremotelogin`.");
    const sOut = sRan ? ((ssh.stdout || "") + (ssh.stderr || "")) : "";
    const sshOn = /Remote Login:\s*On/i.test(sOut);
    return {
      status: sshOn ? "warn" : "pass",
      evidence: trimEvidence(sOut || "Remote Login: (not reported)"),
      fix: sshOn ? "Remote Login (SSH) is on. Disable it if not needed (`sudo systemsetup -setremotelogin off`) or restrict it to a VPN and key-based auth." : "Remote Login (SSH) is off.",
    };
  },
  remoteAccessLinux(r) {
    if (!ran(r)) return naVerdict(r, "Check for running sshd/xrdp/vnc services.");
    const out = (r.stdout || "").toLowerCase();
    const svcs = [];
    if (/sshd/.test(out)) svcs.push("sshd");
    if (/xrdp/.test(out)) svcs.push("xrdp");
    if (/vnc|x11vnc|tigervnc/.test(out)) svcs.push("vnc");
    return {
      status: svcs.length ? "warn" : "pass",
      evidence: trimEvidence(svcs.length ? "Remote-access services running: " + svcs.join(", ") : "No remote-access service detected."),
      fix: svcs.length ? "Remote access is enabled (" + svcs.join(", ") + "). Keep it behind a VPN, use key-based auth, and disable what you do not use." : "No remote-access daemon is running.",
    };
  },

  // ---- Persistence / startup inventory (review, not verdict) -----------
  persistenceInventory(r, kind) {
    if (!ran(r)) return naVerdict(r, "Could not enumerate startup/persistence items.");
    const out = (r.stdout || "").trim();
    const lines = out.split("\n").filter((l) => l.trim()).length;
    return {
      status: lines ? "warn" : "pass",
      evidence: trimEvidence(out || "(none)"),
      fix: lines ? "Review these " + lines + " startup/persistence entries (" + (kind || "items") + "). Remove anything you do not recognize. This is an inventory for review, not an automatic finding." : "No startup/persistence entries found in this location.",
    };
  },

  // ---- Time sync --------------------------------------------------------
  timeSyncLinux(r) {
    if (!ran(r)) return naVerdict(r, "Run `timedatectl` and confirm NTP sync.");
    const out = r.stdout || "";
    const synced = /System clock synchronized:\s*yes/i.test(out) || /NTP service:\s*active/i.test(out);
    return { status: synced ? "pass" : "warn", evidence: trimEvidence(out), fix: synced ? "System clock is NTP-synchronized." : "Enable time sync: `sudo timedatectl set-ntp true`." };
  },
  timeSyncMac(r) {
    if (!ran(r)) return naVerdict(r, "Run `systemsetup -getusingnetworktime`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const on = /Network Time:\s*On/i.test(out);
    return { status: on ? "pass" : "warn", evidence: trimEvidence(out), fix: on ? "Network time is on." : "Enable network time: `sudo systemsetup -setusingnetworktime on`." };
  },
  timeSyncWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `w32tm /query /status`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const ok = /Source:\s*\S+/i.test(out) && !/free-running/i.test(out);
    return { status: ok ? "pass" : "warn", evidence: trimEvidence(out), fix: ok ? "Windows Time service is synchronizing." : "Start and configure the Windows Time service (`w32tm /resync`)." };
  },

  // ---- Secure Boot ------------------------------------------------------
  secureBootLinux(r) {
    if (!ran(r)) return naVerdict(r, "Run `mokutil --sb-state` (UEFI systems only).");
    const out = (r.stdout || "") + (r.stderr || "");
    if (/EFI variables are not supported|not supported/i.test(out)) return naVerdict({ na: true, reason: "non-UEFI / Secure Boot not supported on this platform" });
    const on = /SecureBoot enabled/i.test(out);
    return { status: on ? "pass" : "warn", evidence: trimEvidence(out), fix: on ? "Secure Boot is enabled." : "Enable Secure Boot in UEFI firmware settings (where supported by the OS/boot chain)." };
  },
  secureBootWindows(r) {
    if (!ran(r)) return naVerdict(r, "Run `Confirm-SecureBootUEFI`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const on = /True/i.test(out) && !/False/i.test(out);
    if (/not supported|Cmdlet not supported/i.test(out)) return naVerdict({ na: true, reason: "Secure Boot not supported (legacy BIOS)" });
    return { status: on ? "pass" : "warn", evidence: trimEvidence(out), fix: on ? "Secure Boot is enabled." : "Enable Secure Boot in UEFI firmware settings." };
  },

  // ---- Bluetooth discoverable (macOS, low) ------------------------------
  bluetoothMac(r) {
    if (!ran(r)) return naVerdict(r, "Check `defaults read /Library/Preferences/com.apple.Bluetooth`.");
    const out = (r.stdout || "") + (r.stderr || "");
    const disc = /DiscoverableState\s*=?\s*1/i.test(out);
    return { status: disc ? "warn" : "pass", evidence: trimEvidence(out || "(not discoverable)"), fix: disc ? "Bluetooth is discoverable. It becomes discoverable only while the settings pane is open; close it, and disable Bluetooth when unused." : "Bluetooth is not in discoverable mode." };
  },
};

// =========================================================================
// SCORING — weighted by severity, `na`/`error` excluded, shown transparently.
// =========================================================================

const SEV_WEIGHT = { high: 3, medium: 2, low: 1 };

function scoreResults(results) {
  let earned = 0, possible = 0;
  let pass = 0, fail = 0, warn = 0, na = 0, error = 0;
  for (const r of results) {
    if (r.status === "pass") pass++;
    else if (r.status === "fail") fail++;
    else if (r.status === "warn") warn++;
    else if (r.status === "na") { na++; continue; }
    else if (r.status === "error") { error++; continue; }
    const w = SEV_WEIGHT[r.severity] || 1;
    possible += w;
    if (r.status === "pass") earned += w;
    else if (r.status === "warn") earned += w * 0.5; // partial credit for a soft finding
  }
  const percent = possible ? Math.round((earned / possible) * 100) : null;
  let grade = "n/a";
  if (percent != null) grade = percent >= 90 ? "A" : percent >= 80 ? "B" : percent >= 70 ? "C" : percent >= 60 ? "D" : "F";
  return { percent, grade, earned: Math.round(earned * 10) / 10, possible, counts: { pass, fail, warn, na, error, total: results.length } };
}

// =========================================================================
// EXPORTERS
// =========================================================================

function toJSON(report) { return JSON.stringify(report, null, 2); }

function csvCell(v) {
  let s = String(v == null ? "" : v).replace(/[\r\n]+/g, " "); // collapse ALL CR/LF (a lone \r is a row break in Excel), not only CRLF
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection (CSV)
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(report) {
  const head = ["id", "title", "cisRef", "status", "severity", "category", "evidence", "fix"];
  const rows = [head.join(",")];
  for (const r of report.results) rows.push(head.map((k) => csvCell(r[k])).join(","));
  return rows.join("\n");
}

function toText(report) {
  const L = [];
  L.push("DARKNODE — WORKSTATION SECURITY AUDIT");
  L.push("=".repeat(46));
  L.push("Host:       " + (report.host || "unknown"));
  L.push("OS:         " + (report.os || "unknown"));
  L.push("Generated:  " + (report.generated || ""));
  if (report.score) {
    L.push("Score:      " + (report.score.percent == null ? "n/a" : report.score.percent + "% (" + report.score.grade + ")") + "  [weighted; na/error excluded]");
    const c = report.score.counts;
    L.push("Checks:     " + c.pass + " pass · " + c.fail + " fail · " + c.warn + " warn · " + c.na + " n/a · " + c.error + " error (" + c.total + " total)");
  }
  L.push("");
  const order = { fail: 0, warn: 1, error: 2, pass: 3, na: 4 };
  const sorted = report.results.slice().sort((a, b) => (order[a.status] - order[b.status]) || a.id.localeCompare(b.id));
  for (const r of sorted) {
    L.push("[" + r.status.toUpperCase() + "] " + r.title + "  (" + r.cisRef + ", " + r.severity + ")");
    if (r.evidence) L.push("  evidence: " + String(r.evidence).replace(/\n/g, "\n            "));
    if (r.status !== "pass" && r.fix) L.push("  fix:      " + String(r.fix).replace(/\n/g, "\n            "));
    L.push("");
  }
  return L.join("\n");
}

// Fleet-collect export: a compact, portable record a business can aggregate
// across machines. Evidence is dropped to keep it small and low-sensitivity.
function toFleetRecord(report) {
  return {
    host: report.host || "unknown",
    os: report.os || "unknown",
    generated: report.generated || null,
    appVersion: report.appVersion || null,
    score: report.score || null,
    results: report.results.map((r) => ({ id: r.id, status: r.status, severity: r.severity, cisRef: r.cisRef })),
  };
}

// =========================================================================
// RUNNER — wires fixed commands to the pure parsers. `exec(bin,args,opts)` must
// resolve to { ok, code, stdout, stderr, error?, na?, reason? } and NEVER use a
// shell. Checks run read-only; nothing here elevates privileges.
// =========================================================================


function finalize(def, verdict) {
  return {
    id: def.id, title: def.title, cisRef: def.cisRef, severity: def.severity,
    category: def.category || "general",
    status: verdict.status, evidence: verdict.evidence, fix: verdict.fix,
  };
}

// Run one check: `body(exec)` awaits its own fixed commands and returns a verdict
// from a pure parser. A thrown parser is contained as an `error` result so one
// bad check never aborts the audit.
async function step(add, def, body) {
  try {
    const verdict = await body();
    add(finalize(def, verdict));
  } catch (e) {
    add(finalize(def, { status: "error", evidence: String((e && e.message) || e), fix: "This check errored while running or parsing; re-run or review manually." }));
  }
}

function homePath(sub) { try { return require("os").homedir() + sub; } catch (_) { return sub; } }

async function runAudit({ platform, exec, host, osDescription, appVersion } = {}) {
  platform = platform || process.platform;
  if (typeof exec !== "function") throw new Error("runAudit requires an exec(bin,args,opts) function");
  const results = [];
  const add = (r) => results.push(r);

  if (platform === "darwin") await runMac(exec, add);
  else if (platform === "win32") await runWindows(exec, add);
  else if (platform === "linux") await runLinux(exec, add);
  else add({ id: "platform", title: "Operating system", cisRef: "n/a", severity: SEV.LOW, category: "general", status: "na", evidence: "Unsupported platform: " + platform, fix: "The workstation audit supports macOS, Windows and Linux." });

  const report = {
    host: host || null,
    os: osDescription || platform,
    platform,
    appVersion: appVersion || null,
    generated: new Date().toISOString(),
    results,
  };
  report.score = scoreResults(results);
  return report;
}

async function runMac(exec, add) {
  const C = "macos";
  await step(add, { id: "disk-encryption", title: "Disk encryption (FileVault)", cisRef: "CIS macOS 2.6.1.1", severity: SEV.HIGH, category: C },
    async () => parsers.diskEncryptionMac(await exec("fdesetup", ["status"])));
  await step(add, { id: "firewall", title: "Host firewall", cisRef: "CIS macOS 2.2.1", severity: SEV.HIGH, category: C },
    async () => parsers.firewallMac(await exec("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"])));
  await step(add, { id: "auto-updates", title: "Automatic OS updates", cisRef: "CIS macOS 1.2", severity: SEV.MEDIUM, category: C },
    async () => parsers.autoUpdatesMac(await exec("defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticCheckEnabled"]), await exec("defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates"])));
  await step(add, { id: "screen-lock", title: "Screen lock / idle timeout", cisRef: "CIS macOS 2.10.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.screenLockMac(await exec("sysadminctl", ["-screenLock", "status"]), await exec("defaults", ["-currentHost", "read", "com.apple.screensaver", "idleTime"]), await exec("defaults", ["-currentHost", "read", "com.apple.screensaver", "askForPassword"])));
  await step(add, { id: "gatekeeper", title: "Gatekeeper", cisRef: "CIS macOS 2.4.x", severity: SEV.HIGH, category: C },
    async () => parsers.gatekeeperMac(await exec("spctl", ["--status"])));
  await step(add, { id: "sip", title: "System Integrity Protection", cisRef: "CIS macOS 5.x", severity: SEV.HIGH, category: C },
    async () => parsers.sipMac(await exec("csrutil", ["status"])));
  await step(add, { id: "sshd", title: "SSH daemon hardening", cisRef: "CIS macOS 2.3.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.sshd(await exec("sshd", ["-T"])));
  await step(add, { id: "guest-account", title: "Guest account disabled", cisRef: "CIS macOS 6.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.guestMac(await exec("defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "GuestEnabled"])));
  await step(add, { id: "remote-login", title: "Remote access", cisRef: "CIS macOS 2.3.1", severity: SEV.MEDIUM, category: C },
    async () => parsers.remoteLoginMac(await exec("systemsetup", ["-getremotelogin"]), null));
  await step(add, { id: "listening-services", title: "Listening services", cisRef: "CIS macOS 2.2.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.listeningServices(await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])));
  await step(add, { id: "persistence-launchagents", title: "Startup items (LaunchAgents/Daemons)", cisRef: "CIS macOS 2.x (review)", severity: SEV.LOW, category: C },
    async () => parsers.persistenceInventory(await exec("ls", ["-1", homePath("/Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"]), "launch items"));
  await step(add, { id: "time-sync", title: "Network time sync", cisRef: "CIS macOS 2.3.2", severity: SEV.LOW, category: C },
    async () => parsers.timeSyncMac(await exec("systemsetup", ["-getusingnetworktime"])));
  await step(add, { id: "bluetooth", title: "Bluetooth discoverable", cisRef: "CIS macOS 2.1.x", severity: SEV.LOW, category: C },
    async () => parsers.bluetoothMac(await exec("defaults", ["read", "/Library/Preferences/com.apple.Bluetooth", "DiscoverableState"])));
}

async function runWindows(exec, add) {
  const C = "windows";
  const ps = (script) => ["-NoProfile", "-NonInteractive", "-Command", script];
  await step(add, { id: "disk-encryption", title: "Disk encryption (BitLocker)", cisRef: "CIS Windows 18.9.x", severity: SEV.HIGH, category: C },
    async () => parsers.diskEncryptionWindows(await exec("manage-bde", ["-status", "C:"])));
  await step(add, { id: "firewall", title: "Host firewall", cisRef: "CIS Windows 9.x", severity: SEV.HIGH, category: C },
    async () => parsers.firewallWindows(await exec("netsh", ["advfirewall", "show", "allprofiles", "state"])));
  await step(add, { id: "auto-updates", title: "Automatic OS updates", cisRef: "CIS Windows 18.9.108.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.autoUpdatesWindows(await exec("sc", ["qc", "wuauserv"]), await exec("reg", ["query", "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU", "/v", "NoAutoUpdate"])));
  await step(add, { id: "screen-lock", title: "Screen lock / idle timeout", cisRef: "CIS Windows 19.1.3.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.screenLockWindows(await exec("reg", ["query", "HKCU\\Control Panel\\Desktop", "/v", "ScreenSaveTimeOut"]), await exec("reg", ["query", "HKCU\\Control Panel\\Desktop", "/v", "ScreenSaverIsSecure"])));
  await step(add, { id: "defender", title: "Microsoft Defender real-time protection", cisRef: "CIS Windows 18.9.47.x", severity: SEV.HIGH, category: C },
    async () => parsers.defenderWindows(await exec("powershell", ps("Get-MpComputerStatus | Format-List RealTimeProtectionEnabled,AntivirusEnabled,AntivirusSignatureAge"))));
  await step(add, { id: "secure-boot", title: "Secure Boot", cisRef: "CIS Windows 18.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.secureBootWindows(await exec("powershell", ps("Confirm-SecureBootUEFI"))));
  await step(add, { id: "guest-account", title: "Guest account disabled", cisRef: "CIS Windows 1.1.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.guestWindows(await exec("net", ["user", "guest"])));
  await step(add, { id: "password-policy", title: "Local password & lockout policy", cisRef: "CIS Windows 1.1/1.2", severity: SEV.MEDIUM, category: C },
    async () => parsers.passwordPolicyWindows(await exec("net", ["accounts"])));
  await step(add, { id: "remote-access", title: "Remote Desktop (RDP)", cisRef: "CIS Windows 18.9.65.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.remoteAccessWindows(await exec("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server", "/v", "fDenyTSConnections"])));
  await step(add, { id: "listening-services", title: "Listening services", cisRef: "CIS Windows 9.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.listeningServices(await exec("netstat", ["-ano"])));
  await step(add, { id: "persistence-run", title: "Startup items (Run keys)", cisRef: "CIS Windows (review)", severity: SEV.LOW, category: C },
    async () => parsers.persistenceInventory(await exec("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"]), "Run keys"));
  await step(add, { id: "persistence-tasks", title: "Scheduled tasks", cisRef: "CIS Windows (review)", severity: SEV.LOW, category: C },
    async () => parsers.persistenceInventory(await exec("schtasks", ["/query", "/fo", "csv", "/nh"]), "scheduled tasks"));
  await step(add, { id: "time-sync", title: "Network time sync", cisRef: "CIS Windows 2.3.x", severity: SEV.LOW, category: C },
    async () => parsers.timeSyncWindows(await exec("w32tm", ["/query", "/status"])));
}

async function runLinux(exec, add) {
  const C = "linux";
  await step(add, { id: "disk-encryption", title: "Disk encryption (LUKS/dm-crypt)", cisRef: "CIS Ubuntu 1.1.x", severity: SEV.HIGH, category: C },
    async () => parsers.diskEncryptionLinux(await exec("lsblk", ["-o", "NAME,TYPE,FSTYPE,MOUNTPOINT"]), await exec("dmsetup", ["status"])));
  await step(add, { id: "firewall", title: "Host firewall", cisRef: "CIS Ubuntu 3.5.x", severity: SEV.HIGH, category: C },
    async () => parsers.firewallLinux(await exec("ufw", ["status"]), await exec("firewall-cmd", ["--state"]), await exec("nft", ["list", "ruleset"]), await exec("iptables", ["-S"])));
  await step(add, { id: "auto-updates", title: "Automatic security updates", cisRef: "CIS Ubuntu 1.9", severity: SEV.MEDIUM, category: C },
    async () => parsers.autoUpdatesLinux(await exec("apt-config", ["dump", "APT::Periodic"]), await exec("systemctl", ["is-active", "dnf-automatic.timer"])));
  await step(add, { id: "screen-lock", title: "Screen lock (GNOME)", cisRef: "CIS Ubuntu 1.8.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.screenLockLinuxGnome(await exec("gsettings", ["get", "org.gnome.desktop.screensaver", "lock-enabled"]), await exec("gsettings", ["get", "org.gnome.desktop.session", "idle-delay"])));
  await step(add, { id: "edr", title: "Endpoint protection present (heuristic)", cisRef: "CIS Ubuntu 1.6 (heuristic)", severity: SEV.MEDIUM, category: C },
    async () => parsers.edrLinux(await exec("ps", ["-eo", "comm"])));
  await step(add, { id: "sshd", title: "SSH daemon hardening", cisRef: "CIS Ubuntu 5.2.x", severity: SEV.HIGH, category: C },
    async () => parsers.sshd(await exec("sshd", ["-T"])));
  await step(add, { id: "password-policy", title: "Password aging policy", cisRef: "CIS Ubuntu 5.5.1.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.passwordPolicyLinux(await exec("cat", ["/etc/login.defs"])));
  await step(add, { id: "admin-count", title: "Administrative (sudo) accounts", cisRef: "CIS Ubuntu 5.3.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.adminCountLinux(await exec("getent", ["group", "sudo", "wheel", "admin"])));
  await step(add, { id: "listening-services", title: "Listening services", cisRef: "CIS Ubuntu 3.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.listeningServices(await exec("ss", ["-tulpn"])));
  await step(add, { id: "remote-access", title: "Remote-access services", cisRef: "CIS Ubuntu 2.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.remoteAccessLinux(await exec("ps", ["-eo", "comm"])));
  await step(add, { id: "persistence-units", title: "Enabled startup units", cisRef: "CIS Ubuntu 2.x (review)", severity: SEV.LOW, category: C },
    async () => parsers.persistenceInventory(await exec("systemctl", ["list-unit-files", "--type=service", "--state=enabled", "--no-legend", "--no-pager"]), "enabled services"));
  await step(add, { id: "time-sync", title: "Network time sync", cisRef: "CIS Ubuntu 2.1.1.x", severity: SEV.LOW, category: C },
    async () => parsers.timeSyncLinux(await exec("timedatectl", [])));
  await step(add, { id: "secure-boot", title: "Secure Boot", cisRef: "CIS Ubuntu 1.4.x", severity: SEV.MEDIUM, category: C },
    async () => parsers.secureBootLinux(await exec("mokutil", ["--sb-state"])));
}

module.exports = {
  parsers, scoreResults, toJSON, toCSV, toText, toFleetRecord, runAudit,
  _internals: { trimEvidence, ran, SEV_WEIGHT },
};
