# CIPP MCP Server

MCP (Model Context Protocol) server for [CIPP](https://github.com/KelvinTegelaar/CIPP) — the CyberDrain Improved Partner Portal. Provides AI assistants with structured access to CIPP's M365 multi-tenant management capabilities.

## Features

- **37 tools** across 11 categories
- Tenant, user, group, and mailbox management
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
git clone https://github.com/wyre-technology/cipp-mcp
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
| Mailboxes | list_mailboxes, list_mailbox_permissions, set_out_of_office, set_email_forwarding |
| Security | list_conditional_access_policies, list_named_locations |
| Standards | list_standards, run_standards_check, list_bpa, list_domain_health |
| Licenses | list_licenses, list_csp_licenses |
| Alerts | list_audit_logs, list_alert_queue |
| GDAP | list_gdap_roles, list_gdap_invites |
| Scheduler | list_scheduled_items, add_scheduled_item |
| Core | ping, get_version, list_logs |

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
