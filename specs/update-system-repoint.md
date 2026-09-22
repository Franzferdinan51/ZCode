## Goal

Repoint every ZCode Local update path at our GitHub releases
(`github.com/Franzferdinan51/ZCode`) so an official Z.ai release can never
overwrite or break the fork, while keeping a supported pipeline for pulling
official *code fixes* into the fork. Rebuild, verify, and install the result
on this PC.

## Success Criteria

- No shipped artifact defaults to an official (`zcode.z.ai`) update source:
  CLI installer, desktop auto-updater, and force-update gate.
- CLI `install.sh`/`latest.json` default to our releases; reinstalling pulls
  our latest binaries.
- Desktop `local` flavor (the fork default) checks OUR electron manifest;
  official manifest/force-update config is unreachable by default.
- `upstream` git remote points at verified official repo
  (`github.com/zai-org/ZCode`) with a cherry-pick runbook.
- Gates green (`typecheck`, `lint`, `architecture:check --changed`,
  affected tests), fresh `dist/zcode` built, installed to
  `~/.zcode-local/runtime` + `~/.local/bin/zcode-local`, smoke-tested.
- Work left uncommitted for morning review (no push/release without ask).

## Context And Current Facts

- CLI/TUI dist (`scripts/build-zcode.mjs`, `scripts/zcode-distribution/installer.mjs`):
  driven by `ZCODE_DIST_BASE_URL`. The 3.15.0 release already bakes our URL
  (`.../releases/download/zcode-local-v3.15.0/`). No in-CLI update check
  exists; updates = re-run `install.sh`. Fresh clones fail the build when
  the env var is unset. Installer honors `ZCODE_DIST_BASE_URL` override and
  falls back to the flat release-asset layout (works with
  `.../releases/latest/download/`).
- Desktop (`packages/desktop/src/main/autoUpdater.ts`,
  `manifestUpdateProvider.ts`, `forceUpdateGuard.ts`): manifest default is
  `https://zcode.z.ai/api/v1/releases/electron/manifest`
  (`DEFAULT_ZCODE_ENDPOINT_ORIGIN` in `packages/shared/src/zcodeEndpoint.ts`);
  force-update config default is `https://zcode.z.ai/api/v1/client/configs`.
  Packaged builds ignore `ZCODE_UPDATE_FEED_URL` overrides (fail-closed to
  official). BUT fork builds default to `local` flavor
  (`desktop-product-identity.mjs`), for which the updater is disabled
  (`enabled: flavor === "production"`, `index.ts:1946`) and the force-update
  gate is skipped (`index.ts:2189`). So desktop is currently safe by being
  update-less; it needs OUR feed, not official's.
- `git ls-remote https://github.com/zai-org/ZCode.git HEAD` succeeds
  (`872ad96...`); no `upstream` remote is configured yet.

## Constraints And Non-goals

- User is asleep: no questions; reversible defaults, assumptions recorded.
- No commit/push/tag/release (not asked for this turn). No official-binary
  runtime opt-in: "pull from official" means code fixes via git, plus the
  pre-existing dev-only feed override stays for debugging.
- We do not ship desktop binaries yet: the electron manifest asset does not
  exist, so a missing manifest must read as "no update", not an error.
- No changes to model/API endpoints (`DEFAULT_ZCODE_ENDPOINT_ORIGIN` stays
  for API use); only update paths are repointed.

## Key Decisions

1. Our update base: `https://github.com/Franzferdinan51/ZCode/releases/latest/download/`
   (stable pointer; installer flat-layout fallback already handles it).
   Release builds keep pinning `--base-url` to the tag URL for
   reproducibility; the *default* becomes our latest-download URL.
2. Desktop `local` flavor gets updater enabled with our manifest
   (`<base>/electron-manifest.yml`); `production`/`preview` behavior
   untouched (official builds keep official feed; only reachable in this
   repo via explicit `ZCODE_OFFICIAL_IDENTITY=1`).
3. Missing/404 our-manifest = "no update available" (fail-soft), because no
   desktop assets are published yet. Malformed manifest = error (fail-closed).
4. Upstream flow is git-only: `upstream` remote + fetch + cherry-pick
   runbook (`specs/upstream-sync.md`). No runtime official-update switch.

## Recommended Approach

Small, flavor-gated changes reusing existing seams (`updateFeedSource`,
`manifestUrl`, `ZCODE_DIST_BASE_URL`, `local` flavor), plus a manifest
generator script for future desktop releases and two runbook docs.

## Work Plan

1. Shared: add our update-base + electron-manifest constants (new
   `@zcode/shared` module or alongside `zcodeEndpoint.ts`).
2. Desktop `index.ts`: for `local` flavor, enable updater and pass
   `updateFeedSource` = our manifest URL (explicit dev override still wins
   when present).
3. `manifestUpdateProvider.ts`: treat HTTP 404 / empty body on OUR manifest
   host as up-to-date signal (new sentinel error or null path), keep
   malformed-manifest errors loud.
4. `autoUpdater.ts`: map the up-to-date signal to idle/"no update" state,
   no error UI.
5. `build-zcode.mjs`: default `--base-url` to our latest-download URL when
   env is unset (keep `--base-url`/env override; update usage text).
6. `latest.json`: keep `baseUrl` field semantics; README install section
   updated to our-releases flow.
7. New `scripts/build-electron-manifest.mjs`: emits version-pinned
   `electron-manifest.yml` (absolute `https://github.com/...` file URLs,
   sha512) for releases that ship desktop assets.
8. Git: `git remote add upstream https://github.com/zai-org/ZCode.git`,
   `git fetch upstream --tags`; write `specs/upstream-sync.md` runbook
   (fetch/diff/cherry-pick/conflict policy; never wholesale merge).
9. Tests: extend/add `.mjs` + `ts` tests for flavor→feed mapping,
   404-means-current, and default base URL.
10. Verify gates, rebuild `dist/zcode`, install on this PC from local
    `dist` via `install.sh`, smoke test (`--help`/version/startup).

## Validation Plan

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Affected unit tests (`node --test` / `tsx --test` for touched areas).
- Simulated update check: `curl` our `/releases/latest/download/latest.json`,
  verify version parse + tarball URL shape; installer dry-run from local
  `dist` (`ZCODE_DIST_BASE_URL=file://...`) into a temp `ZCODE_DIST_HOME`.
- Post-install smoke: `zcode-local --help`, version string, binary launches.
- Desktop: typecheck + unit test of feed mapping (no full Electron build).

## Risks / Rollback

- Risk: enabling updater for `local` changes menu/state behavior. Mitigation:
  narrow mapping (local-only), fail-soft only for 404/empty on our host.
- Risk: `/releases/latest` lags if a release is drafted but unpublished.
  Mitigation: runbook publishes manifest + marks release latest; pinned
  `--base-url` for installs.
- Rollback: defaults are constants + one call-site branch; revert files,
  rebuild, reinstall.

## Open Questions

None (user unavailable; proceeding on the assumptions above).
