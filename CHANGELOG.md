# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
