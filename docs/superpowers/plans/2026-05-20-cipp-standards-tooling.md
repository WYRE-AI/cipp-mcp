# CIPP Standards Template Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five MCP tools to cipp-mcp so CIPP Standards Templates can be created, listed, deleted, and drift-checked as code.

**Architecture:** Each tool follows the existing four-layer pattern — a thin `CippService` method wrapping the internal `request()` helper, a `case` in `CippToolHandler`, an entry in `TOOL_DEFINITIONS`, and membership in the `standards` category array. Service methods are unit-tested against a mocked `global.fetch`, mirroring `tests/cipp.service.domain-health.test.ts`.

**Tech Stack:** TypeScript, Node ≥18, ts-jest, the MCP SDK (`@modelcontextprotocol/sdk`). CIPP Azure Function App backend.

---

## Reference: CIPP endpoints

| Service method            | Verb | CIPP function          | Params / body                          |
|---------------------------|------|------------------------|-----------------------------------------|
| `listStandardTemplates`   | GET  | `listStandardTemplates`| none                                     |
| `getTenantDrift`          | GET  | `ListTenantDrift`      | optional `tenantFilter` query            |
| `getTenantAlignment`      | GET  | `ListTenantAlignment`  | optional `tenantFilter` query            |
| `createStandardTemplate`  | POST | `AddStandardsTemplate` | body = full template JSON object         |
| `deleteStandardTemplate`  | POST | `RemoveStandardTemplate`| body = `{ ID: <templateId> }`           |

The `request()` helper signature is `request<T>(method, path, params?, body?, timeoutMs?)`. GET params become query string; non-GET `body` is JSON-stringified.

---

## Task 0: Branch setup

- [ ] **Step 1: Create the feature branch off updated main**

```bash
git checkout main && git pull origin main
git checkout -b feat/standards-template-tooling
```

---

## Task 1: Read-only service methods

**Files:**
- Modify: `src/services/cipp.service.ts` (append to the Standards section, after `runStandardsCheck` which ends near line 601)
- Test: `tests/cipp.service.standards.test.ts` (create)

- [ ] **Step 1: Write the failing test file**

Create `tests/cipp.service.standards.test.ts`:

```typescript
// Tests for CippService Standards Template tooling.
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');

function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

describe('CippService standards template tooling', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('listStandardTemplates issues a GET to listStandardTemplates', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse([{ GUID: 't1' }])));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await svc.listStandardTemplates();

    expect(result).toEqual([{ GUID: 't1' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url as string).pathname).toMatch(/\/api\/listStandardTemplates$/);
    expect((init as RequestInit).method).toBe('GET');
  });

  it('getTenantDrift GETs ListTenantDrift scoped to a tenant when given one', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse([])));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantDrift('contoso.com');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(/\/api\/ListTenantDrift$/);
    expect(url.searchParams.get('tenantFilter')).toBe('contoso.com');
  });

  it('getTenantDrift omits tenantFilter when no tenant is given', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse([])));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantDrift();

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(/\/api\/ListTenantDrift$/);
    expect(url.searchParams.has('tenantFilter')).toBe(false);
  });

  it('getTenantAlignment GETs ListTenantAlignment scoped to a tenant when given one', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse([])));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantAlignment('contoso.com');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(/\/api\/ListTenantAlignment$/);
    expect(url.searchParams.get('tenantFilter')).toBe('contoso.com');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/cipp.service.standards.test.ts`
Expected: FAIL — `svc.listStandardTemplates is not a function` (methods not yet defined).

- [ ] **Step 3: Implement the three read methods**

In `src/services/cipp.service.ts`, immediately after the `runStandardsCheck` method (the closing `}` of the Standards section), add:

```typescript
  /**
   * List the CIPP Standards Templates configured across the partner tenant.
   * Calls the `listStandardTemplates` Azure Function.
   */
  async listStandardTemplates<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'listStandardTemplates');
  }

  /**
   * Report standards drift for a tenant, or for every tenant when no
   * `tenantFilter` is given. Calls the `ListTenantDrift` Azure Function.
   *
   * @param tenantFilter - Optional tenant domain or identifier.
   */
  async getTenantDrift<T = unknown>(tenantFilter?: string): Promise<T> {
    return this.request<T>(
      'GET',
      'ListTenantDrift',
      tenantFilter ? { tenantFilter } : undefined
    );
  }

  /**
   * Report each tenant's alignment percentage against its assigned
   * Standards Templates, or for every tenant when no `tenantFilter` is
   * given. Calls the `ListTenantAlignment` Azure Function.
   *
   * @param tenantFilter - Optional tenant domain or identifier.
   */
  async getTenantAlignment<T = unknown>(tenantFilter?: string): Promise<T> {
    return this.request<T>(
      'GET',
      'ListTenantAlignment',
      tenantFilter ? { tenantFilter } : undefined
    );
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest tests/cipp.service.standards.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/cipp.service.standards.test.ts src/services/cipp.service.ts
git commit -m "feat: add read-only standards template service methods"
```

---

## Task 2: createStandardTemplate service method

**Files:**
- Modify: `src/services/cipp.service.ts` (append after `getTenantAlignment`)
- Test: `tests/cipp.service.standards.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

In `tests/cipp.service.standards.test.ts`, add inside the `describe` block, after the last `it`:

```typescript
  it('createStandardTemplate POSTs the template body to AddStandardsTemplate intact', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse({ Results: 'ok' })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const template = {
      templateName: 'WYRE Baseline',
      tenantFilter: [{ value: 'AllTenants' }],
      standards: { someStandard: {} },
    };
    await svc.createStandardTemplate(template);

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url as string).pathname).toMatch(/\/api\/AddStandardsTemplate$/);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(template);
  });

  it('createStandardTemplate rejects a template missing tenantFilter without calling CIPP', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse({})));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.createStandardTemplate({ templateName: 'no assignment' })
    ).rejects.toThrow(/tenantFilter/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createStandardTemplate rejects a non-object template', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse({})));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.createStandardTemplate(null as unknown as Record<string, unknown>)
    ).rejects.toThrow(/JSON object/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest tests/cipp.service.standards.test.ts`
Expected: FAIL — `svc.createStandardTemplate is not a function`.

- [ ] **Step 3: Implement createStandardTemplate**

In `src/services/cipp.service.ts`, after `getTenantAlignment`, add:

```typescript
  /**
   * Create or update a CIPP Standards Template (CIPP upserts by GUID).
   * Calls the `AddStandardsTemplate` Azure Function.
   *
   * The template object is passed through to CIPP unchanged — cipp-mcp
   * does not model CIPP's template schema, which keeps this tool stable
   * across CIPP versions. Validation is intentionally light: the object
   * must exist and carry a `tenantFilter` assigning it to at least one
   * tenant (CIPP itself rejects templates without one).
   *
   * @param template - The full Standards Template JSON object.
   */
  async createStandardTemplate<T = unknown>(
    template: Record<string, unknown>
  ): Promise<T> {
    if (template === null || typeof template !== 'object' || Array.isArray(template)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Standards template must be a JSON object.'
      );
    }
    if (template.tenantFilter === undefined || template.tenantFilter === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Standards template must include a "tenantFilter" assigning it to at least one tenant.'
      );
    }
    return this.request<T>('POST', 'AddStandardsTemplate', undefined, template);
  }
```

`McpError` and `ErrorCode` are already imported at the top of the file — no new import needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest tests/cipp.service.standards.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/cipp.service.standards.test.ts src/services/cipp.service.ts
git commit -m "feat: add createStandardTemplate service method"
```

---

## Task 3: deleteStandardTemplate service method

**Files:**
- Modify: `src/services/cipp.service.ts` (append after `createStandardTemplate`)
- Test: `tests/cipp.service.standards.test.ts` (add a test)

- [ ] **Step 1: Write the failing test**

In `tests/cipp.service.standards.test.ts`, add inside the `describe` block, after the last `it`:

```typescript
  it('deleteStandardTemplate POSTs RemoveStandardTemplate with the template ID', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse({ Results: 'deleted' })));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.deleteStandardTemplate('guid-123');

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url as string).pathname).toMatch(/\/api\/RemoveStandardTemplate$/);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ ID: 'guid-123' });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest tests/cipp.service.standards.test.ts`
Expected: FAIL — `svc.deleteStandardTemplate is not a function`.

- [ ] **Step 3: Implement deleteStandardTemplate**

In `src/services/cipp.service.ts`, after `createStandardTemplate`, add:

```typescript
  /**
   * Delete a CIPP Standards Template by ID.
   * Calls the `RemoveStandardTemplate` Azure Function.
   *
   * @param templateId - The GUID of the Standards Template to delete.
   */
  async deleteStandardTemplate<T = unknown>(templateId: string): Promise<T> {
    return this.request<T>('POST', 'RemoveStandardTemplate', undefined, {
      ID: templateId,
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest tests/cipp.service.standards.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/cipp.service.standards.test.ts src/services/cipp.service.ts
git commit -m "feat: add deleteStandardTemplate service method"
```

---

## Task 4: Handler cases

**Files:**
- Modify: `src/handlers/tool.handler.ts` (add cases alongside the existing standards cases near line 306-316)

- [ ] **Step 1: Add the five handler cases**

In `src/handlers/tool.handler.ts`, immediately after the `case 'cipp_run_standards_check': { ... break; }` block, add:

```typescript
        case 'cipp_list_standard_templates': {
          result = await this.cippService.listStandardTemplates();
          break;
        }

        case 'cipp_get_tenant_drift': {
          const { tenantFilter } = args as { tenantFilter?: string };
          result = await this.cippService.getTenantDrift(tenantFilter);
          break;
        }

        case 'cipp_get_tenant_alignment': {
          const { tenantFilter } = args as { tenantFilter?: string };
          result = await this.cippService.getTenantAlignment(tenantFilter);
          break;
        }

        case 'cipp_create_standard_template': {
          const { template } = args as { template: Record<string, unknown> };
          result = await this.cippService.createStandardTemplate(template);
          break;
        }

        case 'cipp_delete_standard_template': {
          const { templateId } = args as { templateId: string };
          result = await this.cippService.deleteStandardTemplate(templateId);
          break;
        }
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: clean `tsc` output, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/handlers/tool.handler.ts
git commit -m "feat: wire standards template tools into the handler"
```

---

## Task 5: Tool definitions and category

**Files:**
- Modify: `src/mcp/tool.definitions.ts` (add definitions after `cipp_run_standards_check` near line 618; extend the `standards` category array near line 831)

- [ ] **Step 1: Add the five tool definitions**

In `src/mcp/tool.definitions.ts`, immediately after the `cipp_run_standards_check` definition object (the one ending near line 618, before `cipp_list_bpa`), add:

```typescript
  {
    name: 'cipp_list_standard_templates',
    description: 'List the CIPP Standards Templates configured across the partner tenant.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      title: 'List standards templates',
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: 'cipp_get_tenant_drift',
    description:
      'Report standards drift — settings that deviate from a tenant\'s assigned ' +
      'Standards Template. Omit tenantFilter to report drift across all tenants.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: {
          type: 'string',
          description:
            'Optional tenant domain or ID. Omit to report drift across all managed tenants.',
        },
      },
    },
    annotations: {
      title: 'Get tenant standards drift',
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: 'cipp_get_tenant_alignment',
    description:
      "Report each tenant's alignment percentage against its assigned Standards " +
      'Templates — the key signal for deciding which standards are safe to ' +
      'promote to Remediate. Omit tenantFilter to report on all tenants.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantFilter: {
          type: 'string',
          description:
            'Optional tenant domain or ID. Omit to report alignment across all managed tenants.',
        },
      },
    },
    annotations: {
      title: 'Get tenant standards alignment',
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  {
    name: 'cipp_create_standard_template',
    description:
      '⚠ HIGH-IMPACT. Creates or updates a CIPP Standards Template (upsert by ' +
      'GUID). A template assigned to tenants with any Remediate-action standard ' +
      'WILL modify those tenants on the next standards run. ' +
      'Confirm with the user before invoking.',
    inputSchema: {
      type: 'object',
      properties: {
        template: {
          type: 'object',
          description:
            'The full Standards Template JSON object. Must include a "tenantFilter" ' +
            'assigning it to at least one tenant.',
        },
      },
      required: ['template'],
    },
    annotations: {
      title: 'Create/update standards template (high-impact)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'cipp_delete_standard_template',
    description:
      '⚠ HIGH-IMPACT. Permanently deletes a CIPP Standards Template by ID. ' +
      'Tenants assigned to it lose the standards it enforced. ' +
      'Confirm with the user before invoking.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'The GUID of the Standards Template to delete.',
        },
      },
      required: ['templateId'],
    },
    annotations: {
      title: 'Delete standards template (high-impact)',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
```

- [ ] **Step 2: Extend the `standards` category array**

In `src/mcp/tool.definitions.ts`, replace the `standards` category array (near line 831) with:

```typescript
  standards: [
    'cipp_list_standards',
    'cipp_run_standards_check',
    'cipp_list_standard_templates',
    'cipp_get_tenant_drift',
    'cipp_get_tenant_alignment',
    'cipp_create_standard_template',
    'cipp_delete_standard_template',
    'cipp_list_bpa',
    'cipp_list_domain_health',
  ],
```

- [ ] **Step 3: Verify build and lint**

Run: `npm run build && npm run lint`
Expected: clean `tsc` and ESLint output, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tool.definitions.ts
git commit -m "feat: add standards template tool definitions"
```

---

## Task 6: CHANGELOG and full verification

**Files:**
- Modify: `CHANGELOG.md` (add an entry under `## [Unreleased]` → `### Added`)

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, append:

```markdown
- Standards Template tooling: `cipp_list_standard_templates`,
  `cipp_create_standard_template`, and `cipp_delete_standard_template`
  manage CIPP Standards Templates; `cipp_get_tenant_drift` and
  `cipp_get_tenant_alignment` report per-tenant standards drift and
  alignment. This lets a standards baseline be managed as code.
```

- [ ] **Step 2: Run the full test suite**

Run: `npx jest`
Expected: PASS — all suites green, including the 8 new standards tests.

- [ ] **Step 3: Verify build and lint once more**

Run: `npm run build && npm run lint`
Expected: clean output.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for standards template tooling"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/standards-template-tooling
gh pr create --title "feat: CIPP Standards Template tooling" \
  --body "Implements docs/superpowers/specs/2026-05-20-cipp-standards-tooling-design.md — five MCP tools to manage CIPP Standards Templates and report tenant drift/alignment. Phase 1 of the standards baseline effort."
```

- [ ] **Step 6: Post-merge live smoke test**

After the PR merges and the Release pipeline deploys the new revision, call `cipp_list_standard_templates` through the MCP gateway and confirm it returns CIPP's configured templates (or an empty list) without error.

---

## Notes for the implementer

- The `request()` helper is `private`; tests exercise the new methods only through their public `CippService` API. Do not test `request()` directly.
- `tests/cipp.service.standards.test.ts` defines its own `jsonResponse` helper — do not import one from `cipp.service.domain-health.test.ts`.
- The `annotations` field already exists on the `McpToolDefinition` interface in `tool.definitions.ts` (lines 23-30). No type change is needed.
- CIPP query parameters are case-insensitive; use `tenantFilter` (camelCase) for consistency with the existing `listStandards` method.
