# Upstream sync runbook (official Z.ai → this fork)

Our binaries and update feeds always come from OUR releases. Official code is
still useful when Z.ai fixes a bug we share. That flow is git-only: review
and cherry-pick source fixes, never install or merge official binaries.

## Remotes

- `origin` → `https://github.com/Franzferdinan51/ZCode.git` (this fork)
- `upstream` → `https://github.com/zai-org/ZCode.git` (official, verified)

Our history descends from upstream, so fixes cherry-pick cleanly most of the
time. Check the relationship any time with:

```bash
git fetch upstream --tags
git log --oneline upstream/main -5
git rev-list --count upstream/main..HEAD   # fork commits ahead
git rev-list --count HEAD..upstream/main   # official commits we lack
```

## Pulling an official fix

1. Fetch and identify the fix commit on `upstream/main`.
2. Inspect it. Reject anything that reintroduces Z.ai login/OAuth, plan
   upsells, official update feeds, or telemetry endpoints as defaults.
   The fork strip is specified in `specs/zai-login-removal.md`; the update
   repoint in `specs/update-system-repoint.md`.
3. Cherry-pick with a trace back to official:
   ```bash
   git cherry-pick -x <official-sha>
   ```
4. Resolve conflicts in favor of fork behavior (local flavor, our feeds,
   no login). If the fix cannot be separated from an official-only feature,
   port the fix by hand instead and note the official commit in the message.
5. Run the gates before pushing:
   ```bash
   pnpm typecheck && pnpm lint && pnpm architecture:check --changed
   pnpm tsx --test packages/ui/test/*.test.ts
   ```
6. Push to `origin/main`. Cut a release only when the fix warrants a new
   build (see README release flow).

## Never do

- Never `git merge upstream/main` wholesale: official releases re-add the
  login/update stack the fork removed. Cherry-pick or hand-port only.
- Never run an official installer/`install.sh`/desktop build against a
  fork installation: official payloads do not understand the fork layout.
- Never point `ZCODE_DIST_BASE_URL`, `ZCODE_UPDATE_FEED_URL`, or the
  Electron manifest at official hosts in a shipped build.
