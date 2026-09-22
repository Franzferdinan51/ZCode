# Z.ai login removal (ZCode Local fork)

## Goal

ZCode Local never had accounts: inference is local LM Studio or user-owned API
keys. Delete the Z.ai/BigModel login, OAuth, account-session, and plan/upsell
surfaces instead of gating them. After this change no login screen, OAuth flow,
account session, logout, quota/plan upsell, or provider-OAuth-connect path
exists in the fork.

## Scope

In scope (delete):

- App-login wall: `WelcomeScreen`, `login/LoginApiKeyForm*`, `useOAuth`,
  `useTokenRefresh`, `useProviderAvailabilityLoginEntryGuard`,
  `useRootOAuthEffects` + exclusive `root/oauth*` / `root/account*` helpers,
  `zcodeJwtInvalidRestartMarker`, store auth slices (`user`,
  `isRestoringOAuthSession`, `oauth*`, `apiKeyLogin*`, `loginEntry*`,
  `authSessionSeq`), `Root` welcome-screen/login wiring, `handleLogout`,
  `onLogin`/`onLogout`/`user` prop drilling (`App`, shell, sidebar, footer,
  settings layers), quick-pick login/logout commands.
- Provider-OAuth-connect + plan/upsell UI: `ModelProviderSection` login
  connect path, `oauthActions`, `Detail`/`StatusCards`/
  `CodingPlanStatusActions` login props, `CodingPlanUpgradeDialog*`,
  `codingPlanUpgradeLoginRecovery`, quota banners, coding-plan settings
  sections/panels, sidebar plan badge/usage-upsell pieces.
- Web/desktop/CLI triggers + newly dead services: `web/auth` Z.ai OAuth,
  desktop OAuth deep-link/preload, CLI login commands/flows, `services/oauth`,
  provider `account-provider-*`, shared `oauth`/`account-provider-state` (only
  what becomes unreferenced).

Out of scope (keep working):

- LM Studio default provider, model catalog, picker, `LM_STUDIO_MODEL` pin.
- API-key provider settings (provider cards, `ApiKeyInput`, templates,
  `providerSettingsService.createPersonalProvider`).
- MCP-server OAuth (`adapters/src/mcp/oauth*`) — unrelated to Z.ai app login.
- `UserInfo`/test-id constants in `@zcode/shared` while any kept surface
  references them.

## Ownership and invariants

- Single owner of removal sequencing: this spec. Each phase ends with
  `pnpm typecheck`, `pnpm lint`, and `pnpm architecture:check --changed` green
  before the next phase starts.
- One path: no `LOCAL_FORK` runtime flags for deleted code — delete, don't
  gate. Keep the existing `localFork` upsell flag only while plan UI still
  exists; remove it with the last upsell.
- No behavior is preserved behind a different end state: logged-in-only
  branches resolve to their logged-out rendering, then the branch is deleted.
- Startup must never block on auth: `isResolvingStartupAuthState` and the
  provider-login-entry guard resolve to "no gate" and are removed.

## Phases

1. App-login wall + OAuth session lifecycle (UI package).
2. Plan/upsell + provider-OAuth-connect paths (UI package).
3. Web/desktop/CLI triggers and dead `services/oauth`, provider
   `account-provider-*`, shared oauth/account leftovers.
4. Maintained tests + full verification gates.

## Phase 3 outcome (web/desktop/CLI/services)

- Deleted: CLI browser-OAuth login (`zcode login` command, TUI OAuth
  options, `loginZCodeCli`/`loginBigmodelCodingPlan`, CLI OAuth client,
  browser opener, OAuth polling/abort helpers, OAuth i18n copy).
- Kept deliberately:
  - CLI `/login *-api-key` setup, `/logout`, `logoutZCodeCli`,
    `configureCodingPlanApiKey` (API-key provider management stays).
  - `services/oauth`, `codingPlanSubscriptionService`, `usageStatsService`
    (still referenced by provider disconnect and entitlement/usage display).
  - Web `auth/*` (share-link viewer login serves link owners' accounts, not
    fork accounts) and the desktop OAuth deep-link receiver (inert without
    initiators; shares a module with workspace-link handling).
  - MCP-server OAuth everywhere (unrelated to Z.ai app login).

## Acceptance

- Accepted: app boots straight into workspace/settings with no login screen;
  no `onLogin`/`onLogout`/`user` props in UI shell/sidebar/settings; no
  `WelcomeScreen`/`useOAuth`/login-entry symbols; `user`/`oauth*`/
  `loginEntry*` gone from the UI store; quota/upgrade surfaces gone;
  `services/oauth` and web/desktop/CLI login triggers gone or proven
  unreferenced and deleted; `pnpm tsx --test packages/ui/test/*.test.ts`,
  `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` green.
- Pruned: migrating existing users' stored OAuth credentials (local fork has
  no account backend; stale credentials are inert and left untouched).
- Pruned: removing `zhipu-account` access types from provider templates while
  builtin registry snapshots still reference them (covered only if phase 3
  proves them unreferenced).

## FOSS replacements

Removed capabilities must keep a local path, using free/open-source means:

- Conversation cloud-share trigger (header `ConversationShareMenu`, published
  to `https://zcode.z.ai/cn/share`, account-backed): removed. Per-row
  copy-to-clipboard (`CopyRowAction` in `v4/ConversationRowView.tsx`, no
  backend) already covers getting text out locally, so no user is left
  without a local path.
- Follow-up (not this change): one-click full-conversation `.md` export
  reusing the dependency-free `ConversationDownload`/`messagesToMarkdown`
  helper in `components/ai-elements/conversation.tsx`, wired to v4
  `ConversationRow[]`. No new dependencies, no cloud service.
- OAuth token refresh, plan purchase, quota upsells: no replacement; these
  exist only to serve Z.ai accounts, which the fork does not have.
