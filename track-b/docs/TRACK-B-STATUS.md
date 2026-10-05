# Track B — foundation status and execution map

DO-001 is signed (Track B): the shipping **Darknode OS** is a Linux
distribution; the from-scratch kernel ("Darknode Obsidian") is a separate
research project. This subtree holds the bounded, verifiable foundation built
this run. Everything that needs a display, GPU, real hardware, a build host, or
CI is listed below as **NOT YET EXECUTED**, with the procedure and the reason —
no measurement is faked.

## Built and verified this run

| Item | Artifact | Verification | Result |
|---|---|---|---|
| DO-010 image-build definition (skeleton) | `distro/darknode-os.image.yaml`, `distro/packages.yaml` | parsed + read by the conformance checker | valid, consumed |
| DO-013 agent control plane + scope-escape suite | `agent-control/` | `node --test track-b/agent-control/scope-escape.test.mjs` | **11/11 pass** |
| DO-014 hardening conformance check | `hardening/` | `node track-b/hardening/conformance-check.mjs` | **5 pass, 0 fail, 3 not-yet-evaluated**, exit 0 |

Reproduce both gates:
```sh
node --test track-b/agent-control/scope-escape.test.mjs
node track-b/hardening/conformance-check.mjs
```

## NOT YET EXECUTED (reason stated; not faked)

| Item | What it needs | Procedure (summary) |
|---|---|---|
| DO-010 reproducible image build + unattended install/upgrade | build host, loop/root, CI, multi-GB output | `mkosi`-class build from the image def with pinned `SOURCE_DATE_EPOCH`; build twice; diff image + SBOM for bit-identical; boot live ISO; run unattended install + in-place upgrade in CI |
| DO-011 compositor (real Wayland, GPU, 120–220ms motion, 60fps) | GPU + display + frame-timing capture | build/fork a Wayland compositor; measure sustained 60fps during drag/workspace-switch/terminal-load with frame timing; translate `darknode-web` `css/styles.css` tokens into the compositor/GTK/Qt themes |
| DO-012 real browser + userland | built image | confirm `firefox-esr` launches (DO-012: a browser icon launches a browser; any app that cannot be provided does not appear in the launcher at all) |
| DO-013 kernel-side enforcement + runtime-compromise test | running image, LSM/seccomp | map `policy.mjs` chokepoint to kernel capabilities; demonstrate a process compromised at runtime cannot exceed scope, in CI |
| DO-014 remaining controls | built image, real hardware, CI | sandbox confinement, verified boot on supporting hardware, hardware-backed secret store; run the conformance check in CI against every built image + secret-scan full history |
| DO-015 first-party apps | compositor + image | engagement dashboard, recon workspace, intercepting proxy, evidence/findings manager, report composer, lab manager, recording terminal, audit-log viewer — each hand-usable AND agent-driveable; no app exists only as an icon |
| DO-016 hardware matrix + reliability | real hardware fleet | publish a compatibility matrix from ACTUAL testing only (GPU, Wi-Fi incl. monitor mode + injection, Bluetooth, suspend/resume, battery, external displays, audio); automated install/boot/smoke per profile; crash reporting with secrets redacted |

## Design-token continuity (DO-011) — recorded requirement
The canonical design tokens (color, type scale, spacing, radius, elevation,
motion) come from `darknode-web` `css/styles.css` and must govern web, the
desktop app, and the OS theme identically. A value defined in only one of the
three is a defect. Not yet wired (needs the compositor).

## Shipping-distro home — recommendation (clarification answer)
**Recommend a dedicated new repository** for the shipping distribution (e.g.
`darknode-os-distro`, or reclaim the `darknode-os` name once the research kernel
has moved to its own repo under the name "Darknode Obsidian").

Reasoning:
- The image-build system + agent control plane is a distinct deliverable from
  both the Electron desktop app (`darknode-app`) and the research kernel.
- Keeping it separate avoids re-coupling the two products DO-001 just
  disentangled.
- This `track-b/` subtree was authored self-contained precisely so it can be
  lifted out with `git subtree split` with no rewrites.

It is staged inside `darknode-app` for this run only because (a) the agent may
not create remote repositories, and (b) `darknode-app` already documents a QEMU
runner that builds Darknode OS on a Debian/Ubuntu/Kali base, so it is the
closest existing Track B home. Not recommended as the permanent home.
