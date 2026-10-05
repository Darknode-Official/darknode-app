# Visual System — Shared Design Tokens & Regression (DA-004)

**Status:** PARTIAL. Canonical token source of truth established and drift-guarded;
visual-regression procedure + exceptions defined; the desktop re-skin onto the
canonical tokens and the screenshot diff are NOT YET EXECUTED (require rendering
both apps on a display — unavailable in this environment — and an owner decision,
below).
**Date:** 2026-10-04

## Ground truth (reproduced from source, [C])

- The website ships a full design system in `darknode-web/public/css/styles.css`
  (**9,592 lines**, not the ~1,130 the brief states), plus `pro-theme.css`
  (14,111 lines). Its token layer is the `:root` / `:root[data-theme="light"]`
  blocks (styles.css lines 9-54).
- The desktop ships its OWN `renderer/styles.css` (**1,449 lines**) with a
  **forked token layer**: it re-declares color/shadow/radius tokens with its own
  values and names. Measured divergences against the website's tokens:
  - **Shared-name, different value (dark):** `--card`, `--card2`, `--line`,
    `--line-2`, `--mut`, `--sh-1`, `--sh-2`, `--r-sm`, `--r-lg`, `--r-xl` (10).
  - **Shared-name, different value (light):** `--mut`, `--sh-1`, `--sh-2` (3).
  - **Name divergence / desktop-only:** `--bg-2` (website uses `--bg2`),
    `--surface-3`, `--ring`, `--sh-pop`, `--r`.
  - **Missing on desktop:** the website's spacing (`--sp-*`), type scale
    (`--fs-*`, `--lh-*`, `--fw-*`), z-index (`--z-*`), motion (`--dur*`,
    `--ease-*`, `--transition-*`), and font tokens are absent — desktop
    hard-codes those values inline instead.

This is exactly the "forked copies / one-off values / parallel system" that
DA-004 prohibits.

## Delivered this item

1. **Canonical token package** — `design/tokens.css`: the website's token blocks
   extracted VERBATIM (dark + light), with a do-not-fork header. This is the
   single source of truth both repos are meant to consume. The website's render
   is unchanged (the values are byte-identical to what it already defines).
2. **Drift guard** — `test/design/tokens-drift.test.mjs` (runs in `npm test`,
   CI-gateable): for every token name shared between `design/tokens.css` and
   `renderer/styles.css`, the desktop value must equal canonical UNLESS listed in
   the baseline. A new fork fails the build (proven: injecting `--txt:#ff0000`
   fails with "undocumented token fork(s): --txt (desktop #ff0000 != canonical
   #e6eefc)"); a baseline entry that stops diverging also fails, so the baseline
   cannot rot.
3. **Shrinking baseline** — `design/tokens-exceptions.json`: the 13 current
   value-forks, each with desktop vs canonical value. Unifying the desktop means
   deleting entries here.
4. **Visual-regression exceptions** — `design/visual-exceptions.json`: the
   desktop-only surfaces (window chrome, boot splash, terminal, VM console,
   native menus, code workbench) that the screenshot diff must ignore, each with
   a reason. These surfaces must still compose canonical tokens.

### Verification

```
$ npm test
  ok   design: tokens.css is the canonical source of truth › canonical dark block defines the core palette + scales
  ok   design: tokens.css is the canonical source of truth › canonical light block overrides the themeable tokens
  ok   design: no desktop token forks the canonical value (beyond baseline) › dark: shared tokens match canonical except the documented baseline
  ok   design: no desktop token forks the canonical value (beyond baseline) › light: shared tokens match canonical except the documented baseline
115 passed, 0 failed

# negative check (guard catches a new fork):
$ sed -i 's/--txt:#e6eefc;/--txt:#ff0000;/' renderer/styles.css && npm test
  FAIL dark: shared tokens match canonical except the documented baseline
  Error: dark: undocumented token fork(s): --txt (desktop #ff0000 != canonical #e6eefc)
  (reverted)
```

## Visual-regression procedure (defined; NOT YET EXECUTED)

For each shared surface, capture the website render and the desktop render at a
matched viewport and theme, then diff:

1. Build a fixed list of shared surfaces (dashboard, chat/home, settings, HTTP,
   CVE, encode, notes) — exclude the `design/visual-exceptions.json` surfaces.
2. Website render: load the surface in headless Chromium at 1280x800, dark and
   light, screenshot.
3. Desktop render: launch Electron with `DARKNODE_NO_BOOT=1`, navigate to the
   same surface at 1280x800, dark and light, screenshot via `webContents`.
4. Diff each pair with a pixel-difference metric (e.g. pixelmatch); define a
   per-surface threshold; store baselines under `test/visual/__baselines__/`.
5. Fail CI if any pair exceeds threshold and the surface is not in the exceptions
   file.

**Why not executed here:** this environment has no display/GPU to render Electron
or headless Chromium for the app's own surfaces, and the diff is meaningless
until step 0 below is decided. Reported as NOT YET EXECUTED, not as passing.

## Blocking decision (step 0) — see run report Clarifications

The desktop's current look is a deliberate recent direction (commits moved it
toward a flat "ChatGPT" style). Adopting the website's tokens/skin verbatim
REVERTS that direction, and the two apps also have different markup (the
website's component CSS keys off web-only class names, so its stylesheet cannot
simply be dropped into the desktop shell). Wiring the desktop to render from
`design/tokens.css` (and removing its forked `:root`) therefore:

- changes the desktop's appearance (needs visual verification on a display), and
- requires the owner to confirm the target is "visually identical to the
  website" (per the brief) rather than the recently-chosen flat look.

Because this cannot be round-tripped mid-run and would rip out deliberate work
unverifiably, the re-skin is deferred. The token package + guard + procedure are
the safe, non-destructive foundation that make the re-skin mechanical and
measurable once that decision and a render environment are available.

## Residual risk

- No pixel diff has been run; "visually identical" is unproven and not claimed.
- `design/tokens.css` is a committed copy, not yet a published shared package
  consumed by both repos; keeping it identical to the website currently relies on
  the drift guard + manual re-extraction, not an automated cross-repo import
  (the two repos cannot share an npm package without a publish step, which the
  operating constraints forbid this agent from doing).
