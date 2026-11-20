// Shadow AI and Copilot usage reads, shaped against CIPP's own handlers:
//   Invoke-ListShadowAI.ps1     tenantFilter -> Get-CIPPShadowAIReport (cached data, object body)
//   Invoke-ListCopilotUsage.ps1 tenantFilter, Type (Adoption|Trend|UserDetail), period (default D28)
//                               -> bare array of flattened rows; HTTP 500 with [] on a Graph failure
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { CippToolHandler } from '../src/handlers/tool.handler.js';
import { TOOL_CATEGORIES, TOOL_DEFINITIONS } from '../src/mcp/tool.definitions.js';
import { Logger } from '../src/utils/logger.js';
import { errorResponse, jsonResponse, queryOf } from './helpers.js';

const logger = new Logger('error');

function service(): CippService {
  return new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

function mockFetch(payload: unknown): FetchMock {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(jsonResponse(payload))
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function shadowAiBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: {
      aiToolsDetected: 2,
      deviceInstalls: 3,
      consentedAiApps: 1,
      highRiskTools: 1,
      sanctionedTools: 0,
      intuneSynced: true,
      entraSynced: true,
      lastDataRefresh: '2026-11-10T00:00:00Z',
    },
    byCategory: [{ category: 'Chat', tools: 2, devices: 3 }],
    byRisk: [{ risk: 'High', tools: 1 }],
    topTools: [{ tool: 'ChatGPT', devices: 3, users: 4, footprint: 7, category: 'Chat', status: 'Unsanctioned' }],
    detectedApps: [
      {
        application: 'ChatGPT',
        aiTool: 'ChatGPT',
        risk: 'High',
        deviceCount: 3,
        managedDevices: [{ id: 'd1', deviceName: 'PC-1' }],
      },
    ],
    consentedApps: [
      {
        application: 'ChatGPT Connector',
        aiTool: 'ChatGPT',
        applicationId: 'app-1',
        activeUsersLast7Days: 4,
        applicationUsers: [{ userPrincipalName: 'a@contoso.com', signIns: 5 }],
      },
    ],
    ...overrides,
  };
}

describe('CippService getShadowAi', () => {
  it('calls ListShadowAI with the tenant and returns the report', async () => {
    const fetchMock = mockFetch(shadowAiBody());

    const report = await service().getShadowAi('contoso.com');

    expect(queryOf(fetchMock, 'ListShadowAI').get('tenantFilter')).toBe('contoso.com');
    expect(report.tenantFilter).toBe('contoso.com');
    expect(report.summary.aiToolsDetected).toBe(2);
    expect(report.byRisk).toEqual([{ risk: 'High', tools: 1 }]);
    expect(report.topTools).toHaveLength(1);
    expect(report.warnings).toBeUndefined();
  });

  it('drops per-device and per-user rows unless detail is requested', async () => {
    mockFetch(shadowAiBody());
    const trimmed = await service().getShadowAi('contoso.com');
    expect(trimmed.detectedApps[0]).not.toHaveProperty('managedDevices');
    expect(trimmed.detectedApps[0].deviceCount).toBe(3);
    expect(trimmed.consentedApps[0]).not.toHaveProperty('applicationUsers');
    expect(trimmed.consentedApps[0].activeUsersLast7Days).toBe(4);

    mockFetch(shadowAiBody());
    const full = await service().getShadowAi('contoso.com', { detail: true });
    expect(full.detectedApps[0].managedDevices).toHaveLength(1);
    expect(full.consentedApps[0].applicationUsers).toHaveLength(1);
  });

  it('warns that empty lists mean unsynced data when CIPP has not cached the datasets', async () => {
    mockFetch(
      shadowAiBody({
        summary: { aiToolsDetected: 0, intuneSynced: false, entraSynced: false },
        detectedApps: [],
        consentedApps: [],
      })
    );

    const report = await service().getShadowAi('contoso.com');

    expect(report.warnings).toHaveLength(2);
    expect(report.warnings?.join(' ')).toMatch(/most likely never synced/);
    expect(report.warnings?.join(' ')).toMatch(/dataset is empty/);
  });

  it('tolerates empty collections that PowerShell collapsed to null', async () => {
    mockFetch({ summary: { intuneSynced: true, entraSynced: true }, detectedApps: [null], consentedApps: null });

    const report = await service().getShadowAi('contoso.com');

    expect(report.detectedApps).toEqual([]);
    expect(report.consentedApps).toEqual([]);
    expect(report.topTools).toEqual([]);
  });

  it.each(['allTenants', ' ALLTENANTS '])('rejects %p without calling CIPP', async (tenantFilter) => {
    const fetchMock = mockFetch(shadowAiBody());
    await expect(service().getShadowAi(tenantFilter)).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CippService listCopilotUsage', () => {
  // Invoke-ListCopilotUsage.ps1 always answers Adoption with one row per $ProductMap entry.
  const PRODUCTS = [
    'Any App',
    'Microsoft Teams',
    'Word',
    'Excel',
    'PowerPoint',
    'Outlook',
    'OneNote',
    'Loop',
    'Copilot Chat',
  ];
  const adoption = PRODUCTS.map((product, i) => ({ product, enabledUsers: 10, activeUsers: i }));
  const adoptionWithoutData = PRODUCTS.map((product) => ({ product, enabledUsers: null, activeUsers: null }));

  it('defaults to the Adoption report for D28', async () => {
    const fetchMock = mockFetch(adoption);

    const report = await service().listCopilotUsage('contoso.com');

    const query = queryOf(fetchMock, 'ListCopilotUsage');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('Type')).toBe('Adoption');
    expect(query.get('period')).toBe('D28');
    expect(report).toMatchObject({ type: 'Adoption', period: 'D28', returned: 9, total: 9 });
    expect(report.rows).toEqual(adoption);
    expect(report.warnings).toBeUndefined();
  });

  it('passes type and period through', async () => {
    const fetchMock = mockFetch([{ userPrincipalName: 'a@contoso.com', word: '2026-11-01' }]);

    const report = await service().listCopilotUsage('contoso.com', { type: 'UserDetail', period: 'D90' });

    const query = queryOf(fetchMock, 'ListCopilotUsage');
    expect(query.get('Type')).toBe('UserDetail');
    expect(query.get('period')).toBe('D90');
    expect(report.type).toBe('UserDetail');
  });

  it('applies limit and says rows were cut', async () => {
    mockFetch(Array.from({ length: 5 }, (_, i) => ({ userPrincipalName: `u${i}@contoso.com` })));

    const report = await service().listCopilotUsage('contoso.com', { type: 'UserDetail', limit: 2 });

    expect(report).toMatchObject({ returned: 2, total: 5 });
    expect(report.rows).toHaveLength(2);
    expect(report.warnings?.join(' ')).toMatch(/Returned 2 of 5/);
  });

  it('accepts a { Results } wrapper', async () => {
    mockFetch({ Results: adoption });
    const report = await service().listCopilotUsage('contoso.com');
    expect(report.rows).toEqual(adoption);
  });

  it.each([[[]], [[null]]])('warns instead of reporting zero usage for an empty body %j', async (payload) => {
    mockFetch(payload);

    const report = await service().listCopilotUsage('contoso.com', { type: 'Trend' });

    expect(report.returned).toBe(0);
    expect(report.warnings?.join(' ')).toMatch(/not zero usage/);
  });

  it('warns for the real no-data Adoption shape: 9 product rows with null counts', async () => {
    mockFetch(adoptionWithoutData);

    const report = await service().listCopilotUsage('contoso.com');

    expect(report.total).toBe(9);
    expect(report.warnings?.join(' ')).toMatch(/not zero usage/);
  });

  it('does not warn when an Adoption report has real zero counts', async () => {
    mockFetch(PRODUCTS.map((product) => ({ product, enabledUsers: 5, activeUsers: 0 })));

    const report = await service().listCopilotUsage('contoso.com');

    expect(report.warnings).toBeUndefined();
  });

  it('surfaces an upstream failure as an error', async () => {
    global.fetch = jest.fn(() => Promise.resolve(errorResponse(500, '[]'))) as unknown as typeof fetch;
    await expect(service().listCopilotUsage('contoso.com')).rejects.toBeInstanceOf(McpError);
  });

  it.each([
    [{ type: 'Bogus' as never }],
    [{ period: '28' }],
    [{ period: "D28'; drop" }],
    [{ limit: 0 }],
    [{ limit: 1001 }],
    [{ limit: 1.5 }],
  ])('rejects invalid params %j without calling CIPP', async (params) => {
    const fetchMock = mockFetch(adoption);
    await expect(service().listCopilotUsage('contoso.com', params)).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects allTenants without calling CIPP', async () => {
    const fetchMock = mockFetch(adoption);
    await expect(service().listCopilotUsage('allTenants')).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Shadow AI and Copilot tool registration', () => {
  it('classifies both tools as read-only AI tools', () => {
    for (const name of ['cipp_get_shadow_ai', 'cipp_list_copilot_usage'] as const) {
      const tool = TOOL_DEFINITIONS.find((entry) => entry.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.destructiveHint).toBe(false);
      expect(TOOL_CATEGORIES.ai).toContain(name);
    }
  });

  it('dispatches cipp_get_shadow_ai through the handler', async () => {
    mockFetch(shadowAiBody());
    const handler = new CippToolHandler(service(), logger);

    const result = await handler.handleToolCall('cipp_get_shadow_ai', {
      tenantFilter: 'contoso.com',
      detail: true,
    });

    const parsed = JSON.parse(result.content[0].text) as { detectedApps: Array<Record<string, unknown>> };
    expect(parsed.detectedApps[0].managedDevices).toHaveLength(1);
  });

  it('dispatches cipp_list_copilot_usage through the handler', async () => {
    const fetchMock = mockFetch([{ product: 'Any App', enabledUsers: 1, activeUsers: 1 }]);
    const handler = new CippToolHandler(service(), logger);

    const result = await handler.handleToolCall('cipp_list_copilot_usage', {
      tenantFilter: 'contoso.com',
      type: 'Trend',
      period: 'D30',
    });

    const query = queryOf(fetchMock, 'ListCopilotUsage');
    expect(query.get('Type')).toBe('Trend');
    expect(query.get('period')).toBe('D30');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ returned: 1 });
  });
});
