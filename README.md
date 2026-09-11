# CIPP MCP Server

MCP (Model Context Protocol) server for [CIPP](https://github.com/KelvinTegelaar/CIPP) — the CyberDrain Improved Partner Portal. Provides AI assistants with structured access to CIPP's M365 multi-tenant management capabilities.

## Features

- **45 tools** across 12 categories
- Tenant, user, group, and mailbox management
- Mailbox and online-archive size reporting, per tenant or per user
- Security: Conditional Access policies, named locations
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
| `CIPP_TOKEN_SCOPE` | No | Override OAuth scope (default: `<clientId>/.default`). |
| `CIPP_TOKEN_URL` | No | Override OAuth token endpoint (sovereign clouds only). |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `MCP_HTTP_PORT` | No | Port for HTTP mode (default: 8080) |
| `LOG_LEVEL` | No | `error`, `warn`, `info` (default), or `debug` |

> [!IMPORTANT]
> `CIPP_BASE_URL` must be the **Azure Function App** URL — the CIPP-API backend,
> `https://<function-app-name>.azurewebsites.net` — **not** the Static Web App /
> custom-domain UI URL (e.g. `https://cipp.yourdomain.com`). The SWA's built-in
> auth intercepts bearer tokens and redirects them to its interactive login page,
> so every API call fails. Find the Function App (named like `cippXXXXX`) in your
> CIPP resource group in the Azure Portal.

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
| Users | list_users, create_user, edit_user, disable_user, reset_password, reset_mfa, revoke_sessions, offboard_user, bec_check, list_mfa_users, list_user_devices, list_user_groups |
| Groups | list_groups, create_group |
| Mailboxes | list_mailboxes, list_mailbox_permissions, list_mailbox_usage, get_mailbox_usage, set_out_of_office, set_email_forwarding |
| Security | list_conditional_access_policies, list_named_locations |
| Applications | list_enterprise_apps |
| Standards | list_standards, run_standards_check, list_standard_templates, get_tenant_drift, get_tenant_alignment, create_standard_template, delete_standard_template, list_bpa, list_domain_health |
| Licenses | list_licenses, list_csp_licenses |
| Alerts | list_audit_logs, list_alert_queue |
| GDAP | list_gdap_roles, list_gdap_invites |
| Scheduler | list_scheduled_items, add_scheduled_item |
| Core | ping, get_version, list_logs |

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

### Verified writes

CIPP's response to a write answers "did I accept the job?", not "did the change
land?". Several entrypoints hardcode HTTP 200 and report failure only as a
string in `Results`; others return the moment a job is queued. Relaying that as
success is how an agent ends up telling a technician a password was reset when
it silently was not.

The highest-risk writes — `disable_user`, `reset_password`, `reset_mfa`,
`revoke_sessions` and `create_user` — therefore return a verification envelope
rather than CIPP's raw response:

| Field        | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `status`     | `confirmed`, `pending` or `failed` — see below                      |
| `verifiedBy` | The field or read that would prove the change                       |
| `message`    | Human-facing summary; never claims success unless `confirmed`       |
| `recheck`    | How to confirm by hand. `null` once confirmed                       |
| `failures`   | Failure strings CIPP reported inside a nominally successful reply   |
| `submission` | CIPP's raw acknowledgement, kept verbatim for auditing              |

- **`confirmed`** — a readback proved the change is live in Microsoft, or CIPP
  completed the operation inline and reported no failure. Only this counts as
  done.
- **`pending`** — CIPP accepted the write but it could not be confirmed within
  the verification budget (30s, polled every 3s). **Not a success, and not a
  proven failure.** Relay `recheck` rather than reporting the write as done.
- **`failed`** — CIPP itself reported the operation did not work.

`disable_user` verifies `accountEnabled` is `false`; `reset_password` verifies
`lastPasswordChangeDateTime` advanced past the account's own prior value;
`create_user` verifies the account is visible in `ListUsers`. `reset_mfa` and
`revoke_sessions` have no honest readback — `signInSessionsValidFromDateTime` is
in no property set CIPP returns, and the only MFA read is a cache-backed
tenant-wide report — so they confirm from their own inline result instead of
faking one, and an empty result stays `pending`.

Two notes on `reset_password`: CIPP generates the password itself and ignores
any supplied one, so the tool has no `newPassword` parameter and returns the
generated password in `submission.Results`. On a directory-synced account the
reset goes via password writeback and applies asynchronously, so `pending` is
the expected outcome there.

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
  `status: "failed"`; do not treat a 200 as success. The same trap is what the
  verification envelope above exists for.
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
