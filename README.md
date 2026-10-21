# CIPP MCP Server

MCP (Model Context Protocol) server for [CIPP](https://github.com/CyberDrain/CIPP) — the CyberDrain Improved Partner Portal. Provides AI assistants with structured access to CIPP's M365 multi-tenant management capabilities.

## Features

- **49 tools** across 12 categories
- Tenant, user, group, and mailbox management
- Mailbox and online-archive size reporting, per tenant or per user
- Per-user Entra ID sign-in logs (status, location, Conditional Access, MFA)
- Security: Conditional Access policies, named locations, Microsoft Secure Score
- Standards & compliance: BPA, domain health, drift detection
- License reporting (per-tenant and CSP-wide)
- Alerts, audit logs, and scheduled tasks
- GDAP role and invite management
- Stdio and HTTP transport modes
- MCP Gateway compatible

## Prerequisites

- Node.js 18+
- A running CIPP deployment
- CIPP API Key (generated from CIPP Settings → API Client Management)

## Installation

### Via npm (once published)

```sh
npx cipp-mcp
```

### From source

```sh
git clone https://github.com/WYRE-AI/cipp-mcp
cd cipp-mcp
npm install
npm run build
```

## Configuration

Set these environment variables (or copy `.env.example` to `.env`):

| Variable | Required | Description |
|---|---|---|
| `CIPP_BASE_URL` | Yes | Your CIPP **Azure Function App** URL (e.g. `https://cippXXXXX.azurewebsites.net`). **Do not use the SWA / frontend URL** — see [Finding your Function App URL](#finding-your-function-app-url). |
| `CIPP_API_KEY` | One of | Static Bearer token. Use this **or** the OAuth trio below. |
| `CIPP_TENANT_ID` | One of | Entra tenant ID that owns the CIPP API-client app registration. |
| `CIPP_CLIENT_ID` | One of | OAuth client ID issued by CIPP's API Client Management page. |
| `CIPP_CLIENT_SECRET` | One of | OAuth client secret paired with `CIPP_CLIENT_ID`. |
| `CIPP_TOKEN_SCOPE` | No | Override OAuth scope. Default: `api://<clientId>/.default`. An explicit value disables the legacy-scope fallback below. |
| `CIPP_TOKEN_SCOPE_FALLBACK` | No | When no explicit scope is set, retry a CIPP HTTP 401 once with the legacy `<clientId>/.default` scope and reuse whichever audience this client accepts. Default: `true`. `TOKEN_SCOPE_FALLBACK` is an alias. Gateway requests can send `x-token-scope-fallback`. |
| `CIPP_TOKEN_URL` | No | Override OAuth token endpoint (sovereign clouds only). |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `env` (stdio and single-tenant HTTP) or `gateway`. Gateway mode requires CIPP credential headers on each `/mcp` request and does not fall back to `CIPP_*`. The container image and the Compose gateway service set `gateway`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret shared with the gateway. HTTP logs an error and exits non-zero when this is empty, whitespace, or a known placeholder (`changeme`, `change-me`, `your-s2s-secret`, `your-secret`, `placeholder`, `secret`, `example`, `replace-me`, `replace-with-a-real-secret`, `s2s-secret`, or an unresolved `${...}` value). Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and listens on `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is ignored and the override is logged. This flag does not bypass a known placeholder. |
| `MCP_HTTP_HOST` | No | Bind address when `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` is set. Defaults to `127.0.0.1` when unset. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | Port for HTTP mode (default: 8080) |
| `LOG_LEVEL` | No | `error`, `warn`, `info` (default), or `debug` |

> [!IMPORTANT]
> `CIPP_BASE_URL` must be the **Azure Function App** URL — the CIPP-API backend,
> `https://<function-app-name>.azurewebsites.net` — **not** the Static Web App /
> custom-domain UI URL (e.g. `https://cipp.yourdomain.com`). The SWA's built-in
> auth intercepts bearer tokens and redirects them to its interactive login page,
> so every API call fails. Find the Function App (named like `cippXXXXX`) in your
> CIPP resource group in the Azure Portal.

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The header value is `t=<unix seconds>,v1=<hex>`, where `v1` is the hex-encoded HMAC-SHA256 of the ASCII string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET`. The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before CIPP credentials are read. The secret is never written to logs.

```
X-Gateway-S2S: t=1710000000,v1=<64 lowercase hex chars>
```

In `AUTH_MODE=gateway`, `/mcp` also requires `x-base-url` plus either `x-api-key` or all of `x-tenant-id`, `x-client-id`, and `x-client-secret` (`x-token-scope`, `x-token-url`, and `x-token-scope-fallback` are optional). Those headers are the only CIPP credential source for that request. A request missing them is HTTP 401 and does not use `CIPP_*` from the process environment.

`AUTH_MODE=env` still requires a valid `X-Gateway-S2S` header, then uses `CIPP_*` from the environment.

Local HTTP without a secret is development-only. It binds `127.0.0.1` even when `MCP_HTTP_HOST` is `0.0.0.0` or another non-loopback address:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm run dev
```

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the same S2S secret the gateway uses. In gateway mode, CIPP credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t cipp-mcp .
docker run --rm \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  cipp-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset. The `cipp-mcp` service is gateway mode: it sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not set `CIPP_API_KEY`, `CIPP_CLIENT_ID`, `CIPP_CLIENT_SECRET`, `CIPP_TENANT_ID`, `CIPP_BASE_URL`, or `env_file`.

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `CIPP_*`:

```bash
docker run --rm \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e CIPP_BASE_URL=https://cippXXXXX.azurewebsites.net \
  -e CIPP_TENANT_ID=your-entra-tenant-id \
  -e CIPP_CLIENT_ID=your-client-id \
  -e CIPP_CLIENT_SECRET=your-client-secret \
  -p 127.0.0.1:8080:8080 \
  cipp-mcp
```

## Usage with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cipp": {
      "command": "node",
      "args": ["/path/to/cipp-mcp/dist/entry.js"],
      "env": {
        "CIPP_BASE_URL": "https://cippXXXXX.azurewebsites.net",
        "CIPP_TENANT_ID": "your-entra-tenant-id",
        "CIPP_CLIENT_ID": "your-client-id",
        "CIPP_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

> **Note:** `CIPP_BASE_URL` must be the Azure **Function App** URL (`.azurewebsites.net`), not
> the frontend SWA URL (`.azurestaticapps.net` or your custom domain). The SWA enforces
> browser-based auth and will redirect all API requests to a Microsoft login page.

## Tools

| Category | Tools |
|---|---|
| Tenants | list_tenants, get_tenant_details |
| Users | list_users, create_user, edit_user, disable_user, reset_password, reset_mfa, revoke_sessions, offboard_user, bec_check, list_mfa_users, list_user_devices, list_user_groups, list_user_signin_logs |
| Groups | list_groups, create_group |
| Mailboxes | list_mailboxes, list_mailbox_permissions, list_trusted_blocked_senders, list_mailbox_usage, get_mailbox_usage, set_out_of_office, set_email_forwarding |
| Security | list_conditional_access_policies, list_named_locations, get_secure_score, list_secure_score_controls |
| Applications | list_enterprise_apps |
| Standards | list_standards, run_standards_check, list_standard_templates, get_tenant_drift, get_tenant_alignment, create_standard_template, delete_standard_template, list_bpa, list_domain_health |
| Licenses | list_licenses, list_csp_licenses |
| Alerts | list_audit_logs, list_alert_queue |
| GDAP | list_gdap_roles, list_gdap_invites |
| Scheduler | list_scheduled_items, add_scheduled_item |
| Core | ping, get_version, list_logs |

### Editing a user right after creating it

`edit_user` first resolves the account's current UPN, because CIPP's
`Invoke-EditUser` rebuilds the UPN from `username` + `Domain` on every call and
editing without it would rename the account. Graph can lag a few seconds behind
a just-created account, so when that lookup finds nothing, answers HTTP 404, or
fails with a 5xx whose body is Graph's not-found (the `Request_ResourceNotFound`
code, or Graph's "Resource '<id>' does not exist or one of its queried
reference-property objects are not present" message), it is retried up to 4 attempts in total, waiting 1s, 3s and
6s (~10s). The decision uses the HTTP status, not message text; any other 4xx
(400, 401, 403) and other 5xx are not retried. If the user still isn't visible
the error says "Tried N times" and, when the last attempt got an HTTP error,
its status; wait a moment and retry.

### Mailbox and archive sizes

`list_mailbox_usage` reports every mailbox in a tenant — primary size, item
count, quota, percent of quota, and the same four figures for the online
archive — sorted largest first, with tenant-wide totals that cover every
mailbox even when only the top rows are returned.

**It requires CIPP's reporting database to have been synced for that tenant.**
This is not a design choice: `Invoke-ListMailboxes`' live Exchange query selects
no size fields at all, so the cache is the only tenant-wide source of sizes.
Sync it from CIPP under Reports → Report Settings. If it has not been synced the
tool says so and names the remedy rather than returning an empty result.

`get_mailbox_usage` reports the same figures for a single mailbox and reads
live, so it needs no cache. Prefer it when the cache is unavailable or stale.

Two caveats worth knowing:

- **Concealed report names blank the tenant-wide sizes.** With *Reports:
  conceal user, group, and site names* enabled in the Microsoft 365 admin
  centre, Graph's usage report returns 32-character hashes instead of UPNs, so
  CIPP's join against the mailbox list matches nothing and every mailbox caches
  a size of `0` — a tenant that reads as empty rather than as failed.
  `list_mailbox_usage` detects this and returns a warning alongside the totals.
  `get_mailbox_usage` is unaffected: it reads the Exchange admin API directly.
- **Sizes are gigabyte-rounded on the per-user path.** CIPP rounds to two
  decimal places of a gigabyte before returning, so `get_mailbox_usage` byte
  counts are accurate to roughly 10 MB. Quotas are exact — they are recovered
  from the raw `Get-Mailbox` string, which carries the true byte count.

### User sign-in logs

`list_user_signin_logs` returns one user's most recent interactive sign-ins,
newest first: time, app, IP, location, success or failure with error code and
reason, client app, Conditional Access status and the policies that evaluated,
the authentication methods Graph recorded (first factor included — whether
MFA was required is `authenticationRequirement`), device, and risk when
flagged — plus a summary of failures, distinct IPs and countries.

- **Accepts a UPN or an object id, and always resolves it first.** CIPP filters
  Graph on `userId`, which is the Entra object id; a UPN there matches nothing
  and returns an empty page that reads as "this user never signs in". An
  unresolvable user is an error, not an empty result.
- **One tenant, one user, one page.** `top` defaults to 50 and caps at 1000; a
  full page carries a warning that older sign-ins may exist. `allTenants` is
  rejected — the endpoint has no all-tenants branch. Tenant-wide sign-ins are
  CIPP's Sign-Ins report (`ListSignIns`), which this server does not expose.
- **Needs Entra ID P1/P2 in the tenant.** Graph refuses sign-in log API access
  otherwise; the tool names the licence gap instead of relaying a generic
  "Failed to retrieve Sign In report".

### Microsoft Secure Score

`get_secure_score` returns one tenant's latest Secure Score and its recent
daily history. `list_secure_score_controls` returns the recommendation
catalog: titles, rank, max points, cost, remediation, threats, and any
decision to mark a control resolved by a third party or ignored.

CIPP has no dedicated Secure Score read endpoint. The only Secure Score HTTP
function is `ExecUpdateSecureScore`, which updates a control and is not
exposed here. Both tools call `ListGraphRequest`, which is what CIPP's own
Secure Score page does, with `Endpoint` set to `security/secureScores` or
`security/secureScoreControlProfiles`.

- **One tenant.** `allTenants` is rejected. CIPP's estate view is the nightly
  score cache, not a live Graph call, and these tools do not read that cache.
- **`top` limits history only when pagination is turned off.** `ListGraphRequest`
  treats `$top` as Graph's page size and follows every next link unless
  `NoPagination` is set. `get_secure_score` always sends both, so `top`
  (default 7, maximum 90) is the number of daily readings returned. The
  control catalog leaves pagination on, with a page size of 999, so the full
  list comes back.
- **An empty result is not a score of zero.** A tenant that has not been
  scored yet, or whose CIPP app is missing `SecurityEvents.Read.All`, comes
  back as no reading with a warning. A permission denial names that Graph
  permission instead of a generic CIPP HTTP 400.
- **Comparisons are matched by `basis`.** "All tenants" is `AllTenants` and
  "similar tenants" is `TotalSeats`. Those figures are already percentages.
  The percentage of the tenant's own score is `currentScore / maxScore`, and
  it is omitted when the maximum is missing rather than reported as 0%.

### CIPP version compatibility

Request bodies are shaped against CIPP's own `Invoke-*.ps1` handlers and are
written to satisfy both current and older CIPP builds — where the two differ,
the server sends the form both accept. Three behaviours are worth knowing:

- **`offboard_user` reports queued, not completed.** CIPP's `ExecOffboardUser`
  returns HTTP 200 the instant the job is created; it never waits for or reports
  the offboarding result. Confirm the outcome in CIPP's Offboarding view before
  treating an account as offboarded. The tool refuses a call with no actions
  selected, since that would otherwise queue a job that succeeds while doing
  nothing.
- **Some endpoints report failure under HTTP 200.** `EditUser`,
  `AddScheduledItem` and `ExecOffboardUser` return error text in `Results`
  rather than an error status. These tools parse `Results` and return
  `status: "failed"`; do not treat a 200 as success.
- **Two parameters need a recent CIPP.** `offboard_user`'s
  `DisableOneDriveSharing` and `set_out_of_office`'s `timezone` are ignored by
  older builds rather than erroring — so an offboarding that selects *only*
  `DisableOneDriveSharing` will run no actions on an older CIPP.

## Authentication Setup

CIPP's API Client Management page provisions an Entra ID app registration and
returns an OAuth **client ID + client secret** (not a long-lived Bearer token).
The server exchanges these for a short-lived access token on each request using
the OAuth 2.0 client-credentials flow, and caches the token until just before
its expiry.

1. In CIPP, go to **Settings → CIPP Settings → Integrations → CIPP-API**
2. Create a new API client
3. Copy the **Client ID** and **Client Secret** — you will not be able to
   retrieve the secret later
4. Configure the server with the **Function App URL** (see below):
   ```env
   CIPP_BASE_URL=https://cippXXXXX.azurewebsites.net
   CIPP_TENANT_ID=<your-entra-tenant-id>
   CIPP_CLIENT_ID=<client-id-from-cipp>
   CIPP_CLIENT_SECRET=<client-secret-from-cipp>
   ```

If you already have a static Bearer token (older CIPP deployments), set
`CIPP_API_KEY` instead and leave the OAuth variables unset. When both are
provided, `CIPP_API_KEY` wins.

The access token is requested for `api://<clientId>/.default`. That is the
Application ID URI CIPP's App Service authentication allows. A token requested
for the bare `<clientId>/.default` scope has its `aud` set to the client id
GUID, and App Service auth rejects it with HTTP 401 and an empty body.
Deployments that still expect that legacy audience are handled automatically:
when no explicit scope is configured, a 401 is retried once with the other
automatic audience (`api://<clientId>/.default` or `<clientId>/.default`).
The audience that succeeds is reused for later calls from the same client.
If that audience later starts failing with 401, the pin is dropped and the
other audience is tried once, then whichever succeeds is remembered again.
The retry does not run for any other status (403, 500, and so on), and a
single request never tries more than once. Set `CIPP_TOKEN_SCOPE` to force
a scope, or `CIPP_TOKEN_SCOPE_FALLBACK=false` (alias `TOKEN_SCOPE_FALLBACK`,
gateway header `x-token-scope-fallback`) to skip the retry.

## Finding your Function App URL

CIPP runs as an Azure Static Web App (SWA) backed by an Azure Function App.
The SWA URL (your custom domain or `*.azurestaticapps.net`) enforces browser-only
auth and **cannot be used as `CIPP_BASE_URL`**. Use the Function App URL instead.

**Self-hosted CIPP:** Find the Function App in the Azure portal (look for an App Service
with `Kind: functionapp` in the same resource group as your SWA), or run:
```sh
az staticwebapp show --name <your-swa-name> --resource-group <rg> \
  --query "linkedBackends[0].backendResourceId" -o tsv
```

**CIPP-sponsored hosting:** Contact the CIPP team for your instance's Function App URL —
it is not the same as the URL shown in your browser.

## IP Allowlist

CIPP validates each API client against an `IPRange` field stored in Azure Table Storage.
If your server's public IP is not in this list, you will receive:

> `Access to this CIPP API endpoint is not allowed, the API Client does not have the required permission`

**Self-hosted:** Add your IP via the CIPP UI (Settings → API Client Management) or
directly in the `ApiClients` table of your CIPP storage account.

**CIPP-sponsored hosting:** Ask the CIPP team to add your server's public IP to your
API client's allowed range.

## License

Apache-2.0 — see [LICENSE](LICENSE)

## Contributing

Issues and PRs welcome. This server is tracked against [wyre-technology/msp-claude-plugins#24](https://github.com/wyre-technology/msp-claude-plugins/issues/24).
