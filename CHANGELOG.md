# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Scheduled out-of-office on `cipp_set_out_of_office`** (follow-up from [#75](https://github.com/wyre-technology/cipp-mcp/issues/75)). CIPP supports a `Scheduled` auto-reply state with a start/end window and calendar handling, which the tool's boolean `enabled` could not express — genuinely useful during offboarding. New optional parameters: `startTime`, `endTime` (ISO 8601 or Unix epoch seconds; converted to epoch, which is the form `Invoke-ExecSetOoO` parses unambiguously), `timezone`, `createOOFEvent`, `oofEventSubject`, `autoDeclineFutureRequestsWhenOOF`, `declineEventsForScheduledOOF` and `declineMeetingMessage`. Omitting the window lets CIPP default it to now through seven days later.
  - **`enabled` (boolean) is replaced by `state` (`Enabled` | `Disabled` | `Scheduled`).** A call that omits `state` — including one still sending the old `enabled` — is rejected rather than defaulted, because defaulting would silently disable the auto-reply for a caller asking to turn it on. `enabled` never functioned in any released build (see the `#75` fix below), so no working behaviour is lost.
  - Scheduled-only parameters supplied alongside `Enabled` or `Disabled` are rejected instead of silently dropped; upstream reads them only inside its `Scheduled` branch. `timezone` is exempt — CIPP applies it to every state.
- **CIPP version compatibility section in the README**, covering the three behaviours that differ across CIPP builds: offboarding reports *queued* rather than *completed*, several endpoints report failure under HTTP 200, and `DisableOneDriveSharing` / `timezone` are silently ignored by older builds.

### Fixed
- **`cipp_offboard_user` sent a payload matching nothing in `ExecOffboardUser` — no offboarding action had ever run** ([#72](https://github.com/wyre-technology/cipp-mcp/issues/72)). `Invoke-ExecOffboardUser` reads `$Request.Body.user.value` and hands every other body property to `Invoke-CIPPOffboardingJob` as its options object. The service sent a scalar `ID` plus four invented option names (`revokePermissions`, `disableUser`, `resetPassword`, `transferMailbox`) that match nothing upstream. Because the endpoint returns 200 the instant a task is queued, a technician could offboard a departing employee, see success, and leave the account holding every license, session, and permission.
  - The body now carries `user: [{ value: <UPN> }]` — the `{ value }` shape is required by older CIPP builds and accepted by newer ones — and resolves an object id to the account's current UPN first, since the offboarding tasks anchor Exchange and MFA operations on the UPN.
  - `cipp_offboard_user` now exposes CIPP's real action names (`DisableSignIn`, `RevokeSessions`, `ResetPass`, `RemoveLicenses`, `RemoveGroups`, `RemoveMFADevices`, `RemoveMobile`, `RemoveRules`, `RemoveTeamsPhoneDID`, `removeCalendarInvites`, `removePermissions`, `removeCalendarPermissions`, `ConvertToShared`, `HideFromGAL`, `disableForwarding`, `DisableOneDriveSharing`, `ClearImmutableId`, `DeleteUser`, plus `forward`/`KeepCopy`, `OOO`, and the `AccessAutomap` / `AccessNoAutomap` / `OnedriveAccess` collections). **Breaking:** the four previous option names are gone; they never had any effect.
  - A call selecting no actions is now rejected client-side rather than queueing a job that reports success and does nothing.
  - The result reports `status: "queued"`, never `offboarded`, and says so in the message — CIPP reports success on task *creation*, not completion.
  - Version note: `DisableOneDriveSharing` requires a recent CIPP build; older ones ignore it. CIPP builds predating `Test-CIPPOffboardingRequest` do not validate this payload at all, which is why the old shape failed silently rather than with a 400.
- **`cipp_list_users` silently ignored `searchField` / `searchValue` and returned the entire tenant** ([#73](https://github.com/wyre-technology/cipp-mcp/issues/73)). `Invoke-ListUsers` reads only `tenantFilter`, `UserID` and `graphFilter` from the query string. The search parameters were passed through and dropped, so "find the user matching X" silently became "here is everyone" — a correctness hazard for any caller acting on the result, and large enough on real tenants to blow the client's tool-result limit. Search is now translated into a Graph `$filter`: exact match for `userPrincipalName` and `mail`, prefix match for `displayName` (the schema description now matches the behaviour). Supplying one search parameter without the other is rejected instead of quietly dumping the tenant.
- **`cipp_set_email_forwarding` never sent `forwardOption`; the tool had never worked in any mode** ([#74](https://github.com/wyre-technology/cipp-mcp/issues/74)). `Invoke-ExecEmailForward` switches on `forwardOption` and assigns `$StatusCode` only inside a matching branch. With none sent no branch matched, `$StatusCode` stayed `$null`, and the PowerShell worker crashed constructing the response — surfacing as an opaque HTTP 500 with a worker stack trace rather than an API error. This affected setting a forward as well as disabling one. The service now sends `userID` (not `UserPrincipalName`), `KeepCopy` as the string upstream compares against, and an explicit `forwardOption` derived from the target address: `disabled` when `forwardTo` is omitted, `internalAddress` + `ForwardInternal: { value }` when the address sits on one of the tenant's own domains, and `ExternalAddress` + `ForwardExternal` otherwise. Costs one `ListDomains` GET on the set path only; disabling skips it.
- **`cipp_set_out_of_office` sent `UserPrincipalName` / `enabled` instead of `userId` / `AutoReplyState`** ([#75](https://github.com/wyre-technology/cipp-mcp/issues/75)). `Invoke-ExecSetOoO` reads `userId` and `AutoReplyState`; both of the old keys resolved to `$null`, so `Set-CIPPOutOfOffice` ran with no mailbox and no state and failed with a blank username in the error — easily misread as a tenant-side problem rather than a client bug. The service now sends `userId` and `AutoReplyState: "Enabled" | "Disabled"`, and only includes `InternalMessage` / `ExternalMessage` when non-empty so the state can be flipped without wiping the existing text. (`Scheduled` state with `StartTime` / `EndTime` remains a follow-up — the tool's boolean `enabled` cannot express it.)
- **`cipp_add_scheduled_item`: blank task name, ISO timestamps threw, and CIPP error strings were returned as success** ([#76](https://github.com/wyre-technology/cipp-mcp/issues/76)). Three defects in one method:
  - `Add-CIPPScheduledTask` stores `$task.Name`; the service sent `taskName`, so tasks were created with an empty name — breaking duplicate detection and leaving them effectively unfindable in the scheduler UI. Now sent as `Name`.
  - CIPP casts `[int64]$task.ScheduledTime`. An ISO 8601 string — which the tool schema documented — failed that cast and, because `Invoke-AddScheduledItem` has no try/catch, surfaced as an unhandled HTTP 500. `scheduledTime` still accepts ISO 8601 (or epoch seconds) and is now converted to Unix epoch seconds before it is sent.
  - `Add-CIPPScheduledTask` *returns* error strings rather than throwing for unknown, unauthorised, blocked and duplicate commands, and the entrypoint serves them with a hardcoded HTTP 200. These now surface as `status: "failed"` with the error text, mirroring the `editUser` treatment from [#67](https://github.com/wyre-technology/cipp-mcp/issues/67).
  - Also fixed: `Command` is now sent as `{ value }` (older CIPP stores `[string]$task.Command.value` with no bare-string fallback, so a bare string was stored as an empty command), and a new optional `parameters` object is passed through as `Parameters` — without it, every scheduled command ran with no arguments.
- **`cipp_edit_user` sent a payload shape upstream never reads — UPN handling and licenses were broken** ([#67](https://github.com/wyre-technology/cipp-mcp/issues/67)). CIPP's `Invoke-EditUser` rebuilds the account's `userPrincipalName` on every call from the body's `username` + `Domain` fields (it never reads a `userPrincipalName` field), and reads licenses as `[{ value: skuId }]` objects plus a `removeLicenses` boolean. Our service sent neither shape: any edit risked an HTTP 500 ("The domain portion of the userPrincipalName property is invalid") or, worse, a silent account rename, and license changes were impossible.
  - `editUser` now resolves the target's current identity first (one narrow `ListUsers` lookup by `UserID` or `graphFilter`) and always sends `username` + `Domain` from the resolved UPN; it refuses to edit when the user cannot be resolved rather than risking a rename.
  - New `licenses` (reconciled SKU list, sent as `[{ value }]`) and `removeLicenses` parameters on `cipp_edit_user`; the mutually exclusive combination is rejected.
  - `EditUser` returns HTTP 200 even when the underlying operations fail (upstream reports failures as strings in `Results`); the service now parses `Results` and reports `status: "failed"` with the failure strings instead of implying success.
  - 11 new tests in `tests/cipp.service.edit-user.test.ts`. Fix approach and tests adapted from PR [#66](https://github.com/wyre-technology/cipp-mcp/pull/66) by @pdlaskbis (self-closed before review) — verified independently against upstream `Invoke-EditUser.ps1`.

### Added
- `cipp_list_enterprise_apps` tool — list enterprise applications
  (service principals) in a tenant via the CIPP `ListGraphRequest`
  passthrough against the `/servicePrincipals` Graph endpoint. Returns
  `appId`, `displayName`, `publisherName`, `appOwnerOrganizationId`,
  `signInAudience`, `tags`, and `createdDateTime`. Default filter
  excludes Microsoft-built-in apps (owner-org `f8cdef31-…`); pass
  `includeBuiltIn=true` to include them. Supports `tenantFilter='allTenants'`
  for cross-tenant fan-out — CIPP returns per-tenant errors (e.g. 403 from
  a tenant without GDAP delegated admin) as inline error rows rather than
  failing the whole call. This is the data foundation for the per-tenant
  SaaS-catalog audit (rank customer apps by tenant-frequency).
- OAuth 2.0 client-credentials auth against Entra ID. CIPP's "API Clients"
  integration page issues a client ID + secret — the server now exchanges
  those for a short-lived access token per request and caches it until expiry.
  Configure via `CIPP_TENANT_ID`, `CIPP_CLIENT_ID`, `CIPP_CLIENT_SECRET`
  (optional: `CIPP_TOKEN_SCOPE`, `CIPP_TOKEN_URL`).
- Gateway-mode headers for OAuth: `x-tenant-id`, `x-client-id`,
  `x-client-secret`, `x-token-scope`, `x-token-url`.
- Standards Template tooling: `cipp_list_standard_templates`,
  `cipp_create_standard_template`, and `cipp_delete_standard_template`
  manage CIPP Standards Templates; `cipp_get_tenant_drift` and
  `cipp_get_tenant_alignment` report per-tenant standards drift and
  alignment. This lets a standards baseline be managed as code.

### Fixed
- Unresolved MCPB/DXT config placeholders in credentials no longer break auth.
  Desktop bundles map env vars to `${user_config.X}` in `manifest.json`; when an
  optional field (e.g. the API key) is left blank the host injects the literal
  string `${user_config.cipp_api_key}` rather than an empty value. Because that
  literal is truthy, it silently overrode the OAuth client-credentials path and
  was sent as `Authorization: Bearer ${user_config.cipp_api_key}`, 401'ing every
  request. Credentials are now sanitised at ingress (`cleanCredential` /
  `sanitizeCredentials` in `src/utils/config.ts`) so empty, whitespace-only, and
  `${...}` placeholder values are treated as absent across all sources (env vars,
  gateway env promotion, and HTTP headers). Mirrors itglue-mcp #73.
- Documentation pointed `CIPP_BASE_URL` at the Static Web App / custom-domain
  UI URL (`https://cipp.yourdomain.com`). The SWA's built-in auth redirects
  bearer-token requests to its interactive login page, so every API call
  fails. All examples (README, `.env.example`, `smithery.yaml`,
  `manifest.json`, `docker-compose.yml`) now use the CIPP-API Azure Function
  App URL (`https://<function-app-name>.azurewebsites.net`) and the README
  explains the distinction.
- `cipp_list_domain_health` returned no data — it called CIPP's
  `ListDomainHealth` function with only `tenantFilter`. That function is a
  per-domain DNS helper requiring `Action` + `Domain` query parameters and
  ignores `tenantFilter`; called without them it returns HTTP 200 with an
  empty body, which crashed the client with "Unexpected end of JSON input".
  The tool now enumerates the tenant's domains via `ListDomains`, then runs
  the SPF / DMARC / DKIM checks per domain.
- The HTTP client no longer throws a JSON-parse error on an empty `2xx`
  response body; such responses are treated as "no content".
- `cipp_list_domain_health` could time out at the MCP gateway on tenants
  with several domains: each SPF / DMARC / DKIM check resolves DNS
  server-side at CIPP and the fan-out of slow lookups exceeded the
  gateway's tool-call deadline. Each per-domain DNS check now carries a
  15s abort timeout; a stuck lookup is reported as an `{ error }`
  placeholder for that record instead of hanging the whole tenant.

### Changed
- `cipp_list_domain_health` now skips the tenant's `.onmicrosoft.com`
  routing domain. That domain carries no real customer mail DNS, so its
  SPF / DMARC / DKIM checks only ever hung or failed with no actionable
  result.
- `CIPP_API_KEY` remains supported as a static Bearer token for backwards
  compatibility. When both static and OAuth credentials are provided, the
  static `apiKey` wins.
- Gateway-mode `/mcp` now accepts either `x-api-key` OR the OAuth header
  triple `(x-tenant-id + x-client-id + x-client-secret)`.

## [0.2.0] - 2026-04-21

### Added
- Dockerfile (multi-stage node:22-alpine) for GHCR container image publishing
- docker-compose.yml with production and dev (profile-gated) services
- .dockerignore to keep image lean
- .releaserc.json for semantic-release automated versioning and GitHub releases
- GitHub Actions release workflow: test matrix (Node 18/20/22), semantic-release,
  Docker build+push to GHCR, Trivy security scan, Azure Container Apps deployment
- GitHub Actions add-to-project workflow for project board automation
- smithery.yaml for Smithery marketplace stdio configuration

## [0.1.0] - 2026-04-12

### Added
- Initial MCP server scaffold for CIPP (CyberDrain Improved Partner Portal)
- 37 tools across 11 categories: tenants, users, groups, mailboxes, security, standards, licenses, alerts, GDAP, scheduler, and core
- Bearer token authentication via CIPP_BASE_URL and CIPP_API_KEY environment variables
- Stdio and HTTP (Streamable HTTP) transport support
- MCP Gateway compatible (per-request credential injection via headers)
- Tenant management: list tenants, get tenant details
- User management: list, create, edit, disable, reset password, reset MFA, revoke sessions, offboard, BEC check
- Group management: list groups, create group
- Mailbox tools: list mailboxes, permissions, set out-of-office, set forwarding
- Security tools: list conditional access policies, named locations
- Standards tools: list standards, run compliance check, BPA results, domain health
- License tools: per-tenant and CSP-wide license reporting
- Alert tools: audit logs, alert queue
- GDAP tools: list roles and invites
- Scheduler tools: list and create scheduled tasks
- Core tools: ping, version, logs
