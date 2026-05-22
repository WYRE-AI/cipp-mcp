# CIPP Standards Baseline: Handoff to Jacob

**Date:** 2026-05-22
**From:** Aaron
**To:** Jacob
**Scope:** Jacob owns the operational import / apply of the WYRE standards
baseline (drift-detection policies) into CIPP across the customer fleet.
The cipp-mcp tooling that supports it is already shipped.

## What's shipped (cipp-mcp v1.4.0)

Five new MCP tools, live on the WYRE Gateway against production CIPP:

| Tool | Use |
|---|---|
| `cipp_list_standard_templates` | List the Standards Templates currently configured |
| `cipp_create_standard_template` | Create or update a template (idempotent upsert by GUID) — ⚠ HIGH-IMPACT |
| `cipp_delete_standard_template` | Delete a template by ID — ⚠ HIGH-IMPACT |
| `cipp_get_tenant_drift` | Per-tenant standards drift |
| `cipp_get_tenant_alignment` | Per-tenant alignment % — best signal for promotion decisions |

`cipp_create_standard_template` takes a passthrough Standards Template
JSON object. Required: `tenantFilter` assigning the template to at least
one tenant. Everything else flows through to CIPP unchanged, which keeps
the tool stable across CIPP versions.

Reference docs in this repo:

- Phase 1 spec: `docs/superpowers/specs/2026-05-20-cipp-standards-tooling-design.md`
- Phase 1 plan: `docs/superpowers/plans/2026-05-20-cipp-standards-tooling.md`
- Phase 1 PR (merged): [#21](https://github.com/wyre-technology/cipp-mcp/pull/21)

## Decisions already made (informational, not binding)

These came out of the early brainstorm. They reflect Aaron's preferred
direction — Jacob is welcome to deviate if operational reality calls for
it:

1. **Anchor**: CIPP best-practice defaults.
2. **Posture**: Report-only fleet-wide first, then promote in batches.
3. **Width**: WIDE — every CIPP best-practice standard at `Report`
   action from day one. Report is operationally free; wider Report data
   informs smarter Remediate promotions later.
4. **Scope**: `AllTenants` minus excludes — exclude the partner tenant
   (`wyretechnology.com`), offboarded tenants (`emerald-sg`), and any
   internal lab tenants.

## Verification of the tooling

At the time of writing, calls through the claude.ai → WYRE Gateway
connector were returning `Server not found` for *every* cipp tool
(including the long-existing `cipp_ping`), so a live smoke wasn't
possible. The gateway `/health` was returning 200 and the `gwp-cipp`
revision was RunningAtMaxScale — a connector-side hiccup, not anything
PR #21 introduced. Should clear on connector reload.

Quick smoke when you start:

```text
cipp_list_standard_templates()   → returns CIPP's configured templates (or [])
cipp_get_tenant_alignment(...)   → returns alignment data
```

## Useful context

- **Audit data** is on each customer's own ITGlue org (~30 reports
  posted 2026-05-19 / 2026-05-20). Useful pre-baseline reference for
  which standards already have high alignment.
- **CIPP environment**: `cipp.wyretechnology.com`
  (Function App `cipp6deic.azurewebsites.net`), v10.4.5. Worth
  considering an upgrade before authoring the baseline JSON — newer CIPP
  ships a refreshed best-practice set, and authoring against an outdated
  version means redoing work after upgrade.
- **WYRE Gateway**: cipp tools surface as
  `mcp__claude_ai_WYRE_MCP_Gateway__cipp__*` from a Claude.ai connector.
  Container app `gwp-cipp` in resource group `mcp-gateway-prod`.

— Aaron
