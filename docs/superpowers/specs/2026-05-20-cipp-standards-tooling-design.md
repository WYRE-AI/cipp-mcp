# CIPP Standards Template Tooling — Design

**Date:** 2026-05-20
**Status:** Approved for implementation planning
**Scope:** Phase 1 of the WYRE CIPP standards baseline effort

## Background

WYRE manages ~30 Microsoft 365 customer tenants through CIPP. A fleet-wide
audit surfaced configuration drift with no enforced baseline. CIPP's
**Standards** feature is the enforcing layer: a *Standards Template* is a JSON
object holding a set of standards, each with an `action` of `Report`,
`Alert`, or `Remediate`, assigned to one or more tenants and applied on a
schedule.

cipp-mcp currently exposes only read/trigger tooling for standards
(`cipp_list_standards`, `cipp_run_standards_check`). It cannot author,
list, delete, or drift-check Standards Templates. This project adds that
capability so the baseline can be managed as code.

## Two-phase shape

This effort is split into two coordinated sub-projects, each with its own
spec → plan → implement cycle:

- **Phase 1 (this design): cipp-mcp Standards Template tooling.** New MCP
  tools to create, list, delete, and drift-check Standards Templates. Pure
  software — TDD, PR, deploy.
- **Phase 2 (later, separate brainstorm): the WYRE baseline template +
  staged rollout.** Author the baseline template JSON (anchored to CIPP
  best-practice defaults, every standard at `Report` action), assign it
  fleet-wide, review drift, promote standards to `Remediate` in batches.

Only Phase 1 is in scope here.

## CIPP API surface

Verified against the CIPP-API repository
(`Modules/CIPPHTTP/.../Tenant/Standards`):

| CIPP endpoint            | Verb | Purpose                              |
|--------------------------|------|--------------------------------------|
| `listStandardTemplates`  | GET  | List configured Standards Templates  |
| `AddStandardsTemplate`   | POST | Create or update a template (upsert) |
| `RemoveStandardTemplate` | POST | Delete a template                    |
| `ListTenantDrift`        | GET  | Standards drift for a tenant / fleet |
| `ListTenantAlignment`    | GET  | Alignment percentage per tenant      |

`AddStandardsDeploy` (separate deploy action) is **out of scope** for
Phase 1 — template assignment is carried in the template JSON itself.

## Tools

Five new tools, following the existing service → handler → definition
layering in cipp-mcp.

### Write tools

- **`cipp_create_standard_template`** → `POST AddStandardsTemplate`.
  Accepts a Standards Template JSON object as a passthrough payload. Light
  validation only: required top-level keys present. Creates or updates —
  CIPP upserts by template GUID. Description carries an explicit warning
  that a template assigned to tenants with any `Remediate`-action standard
  will modify those tenants on the next standards run, and a
  "Confirm with the user before invoking." note.
- **`cipp_delete_standard_template`** → `POST RemoveStandardTemplate`.
  Deletes a template by ID. Destructive; confirm-before-invoke.

### Read tools

- **`cipp_list_standard_templates`** → `GET listStandardTemplates`.
- **`cipp_get_tenant_drift`** → `GET ListTenantDrift`. Drift for a tenant
  (or fleet).
- **`cipp_get_tenant_alignment`** → `GET ListTenantAlignment`. Alignment %
  — the primary signal for deciding which standards are safe to promote
  to `Remediate` in Phase 2.

### Why passthrough JSON for create

The CIPP Standards Template schema is large and version-coupled. Building
it from structured tool parameters would couple cipp-mcp to CIPP's
internal schema and break on CIPP upgrades. A validated passthrough keeps
the tool stable across CIPP versions and lets the Phase 2 baseline live as
a reviewable JSON file.

## Architecture

Each tool is implemented across the four existing layers:

1. **`CippService` method** (`src/services/cipp.service.ts`) — a thin
   `request()` wrapper, matching the shape of `listStandards` /
   `runStandardsCheck`.
2. **Handler case** (`src/handlers/tool.handler.ts`).
3. **Tool definition** (`src/mcp/tool.definitions.ts`) — including the
   `annotations` block.
4. **Category array** — added to the `standards` group in
   `tool.definitions.ts`.

### Annotations

Adopts the pattern from the `chore/destructive-tool-warnings` branch:

| Tool                          | readOnlyHint | destructiveHint | idempotentHint | Confirm note |
|--------------------------------|--------------|-----------------|----------------|--------------|
| `cipp_list_standard_templates` | true         | false           | —              | no           |
| `cipp_get_tenant_drift`        | true         | false           | —              | no           |
| `cipp_get_tenant_alignment`    | true         | false           | —              | no           |
| `cipp_create_standard_template`| false        | false           | true           | yes          |
| `cipp_delete_standard_template`| false        | true            | false          | yes          |

`create` is an idempotent upsert (not marked destructive) but carries the
confirm-before-invoke note and the description warning described above.

### Dependency: the `annotations` type

The `annotations` field on the tool-definition type lives on the unmerged
`chore/destructive-tool-warnings` branch. The implementation plan must
resolve one of:

- **(a)** Land `chore/destructive-tool-warnings` first, then build Phase 1
  on top of it; or
- **(b)** Have Phase 1 carry the `annotations` type addition itself.

The implementation plan will pick one based on the branch's current state.

## Error handling

Inherits the hardened `request()` helper: empty-body `2xx` responses are
treated as "no content"; non-`2xx` responses raise `McpError`. No new
error paths are introduced.

## Testing

One new `CippService` unit-test file
(`tests/cipp.service.standards.test.ts`), mocked `global.fetch`, mirroring
`tests/cipp.service.domain-health.test.ts`:

- One test per new method — asserts correct endpoint path, HTTP verb, and
  param/body mapping.
- A passthrough test for `createStandardTemplate` — the supplied template
  body is forwarded to CIPP intact.
- A required-keys validation test for `createStandardTemplate`.

## Delivery

Single PR: service methods + handlers + definitions + tests + CHANGELOG
entry. Conventional-commit `feat:`. CI green → squash-merge →
semantic-release builds the image and deploys to Azure Container Apps via
the existing Release pipeline.

## Out of scope (Phase 2)

- The WYRE baseline template content (which standards, at which action).
- Any tenant assignment or rollout.
- `AddStandardsDeploy` wrapping.
- Promotion of standards from `Report` to `Remediate`.

## Success criteria

- All five tools callable through the MCP gateway against production CIPP.
- `cipp_list_standard_templates` returns CIPP's configured templates.
- `cipp_create_standard_template` round-trips a template (create, then
  list shows it).
- `cipp_get_tenant_drift` / `cipp_get_tenant_alignment` return per-tenant
  data.
- Full test suite green; build and lint clean.
