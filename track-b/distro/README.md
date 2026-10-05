# DO-010 — Base and build system (declarative image)

The shipping **Darknode OS** image is defined by `darknode-os.image.yaml` plus
the `packages.yaml` manifest. Images are built ONLY from these files; hand-built
images are forbidden.

## Files
- `darknode-os.image.yaml` — the single source of truth: base distro + pinned
  snapshot, reproducibility settings, signing, Secure Boot, full-disk
  encryption, outputs, and the embedded agent service.
- `packages.yaml` — the declarative package manifest (real package names only).

## Base distro decision (justified)
**Debian 12 (bookworm) stable.** Reproducible-builds maturity +
`snapshot.debian.org` pinning give bit-identical rebuilds; signed apt repos;
a signed shim (`shim-signed`) for Secure Boot; stability for a security
platform. Kali is used only as a **pinned tool repository** (not the base);
Arch's rolling model is incompatible with reproducible, unattended builds.

## Verified now
- `darknode-os.image.yaml` and `packages.yaml` are valid YAML and are consumed
  by the DO-014 conformance checker, which reads FDE, package-signing, and MAC
  settings from them and passes (`node track-b/hardening/conformance-check.mjs`).

## NOT YET EXECUTED (needs a build host / CI)
These are specified but deliberately not faked. None has been run; no image
exists yet.

1. **Reproducible build.** Procedure: a `mkosi`-class builder consumes
   `darknode-os.image.yaml`, pins `SOURCE_DATE_EPOCH` to the snapshot, installs
   the sorted manifest from `snapshot.debian.org`, and emits image + SBOM.
   Acceptance: two builds produce byte-identical image + SBOM. **Reason not
   executed:** no build host in this environment; debootstrap/mkosi + multi-GB
   image output + root/loop devices are required.
2. **Signed repo + Secure Boot chain.** Signing keys live in an external KMS/HSM
   (never in-repo, never in-image). **Reason not executed:** no KMS and no
   signing key available, by policy.
3. **Installer + live ISO + in-place upgrade.** `install-unattended.example.yaml`
   is referenced but NOT YET AUTHORED. Acceptance: a clean install and an
   in-place upgrade both complete unattended in CI. **Reason not executed:** no
   CI runner / VM host here.
4. **FDE at install.** LUKS2 config is declared; the passphrase/recovery key is
   set at install time and is never stored in this repo or the image.

## Recommended home for the shipping distro
See `../docs/TRACK-B-STATUS.md` ("Shipping-distro home"). Recommendation: a
**dedicated repository**; this `track-b/` subtree is self-contained and can be
`git subtree split` into it. It is staged inside `darknode-app` for this run
because the agent cannot create remote repositories.
