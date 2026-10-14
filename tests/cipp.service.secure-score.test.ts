// Microsoft Secure Score reads go through ListGraphRequest. CIPP-API has no
// Invoke-ListSecureScore; the only Secure Score HTTP function is the write
// Invoke-ExecUpdateSecureScore. CIPP's own page calls:
//   security/secureScores                 $top + NoPagination
//   security/secureScoreControlProfiles   $top as a page size, pagination left on
// Success is { Results, Metadata }. $top without NoPagination is a page size:
// upstream follows @odata.nextLink and a request for 7 readings would return
// the whole series.
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

function mockGraph(payload: unknown): FetchMock {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(jsonResponse(payload))
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** A Graph secureScore, trimmed to the fields the tool reads. */
function score(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'score-new',
    azureTenantId: 'tenant-guid',
    createdDateTime: '2026-10-13T00:00:00Z',
    currentScore: 50,
    maxScore: 100,
    activeUserCount: 40,
    licensedUserCount: 42,
    enabledServices: ['Exchange', 'HasExchange'],
    averageComparativeScores: [
      { basis: 'TotalSeats', averageScore: 40 },
      { basis: 'AllTenants', averageScore: 55.5 },
      { basis: 'IndustryTypes', averageScore: 70 },
    ],
    controlScores: [
      {
        controlName: 'MFARegistration',
        controlCategory: 'Identity',
        score: 9,
        scoreInPercentage: 100,
        description: 'Require MFA',
      },
      {
        controlName: 'AdminMFA',
        controlCategory: 'Identity',
        score: 0,
        scoreInPercentage: 0,
        description: 'MFA for admins',
      },
      {
        controlName: 'TLS',
        controlCategory: 'Data',
        score: 1,
        scoreInPercentage: 50,
        description: 'TLS',
      },
      { controlName: 'Mystery', description: 'No percentage' },
    ],
    ...overrides,
  };
}

describe('CippService getSecureScore', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs ListGraphRequest for security/secureScores with top 7 and NoPagination', async () => {
    const fetchMock = mockGraph({ Results: [score()] });

    await svc.getSecureScore('contoso.com');

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(new URL(url).pathname).toMatch(/\/api\/ListGraphRequest$/);
    const query = queryOf(fetchMock, '/api/ListGraphRequest');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('Endpoint')).toBe('security/secureScores');
    expect(query.get('$top')).toBe('7');
    // Without this, $top is only a page size and CIPP follows every next link.
    expect(query.get('NoPagination')).toBe('true');
    expect([...query.keys()].sort()).toEqual(['$top', 'Endpoint', 'NoPagination', 'tenantFilter']);
  });

  it('forwards top and still pairs it with NoPagination', async () => {
    const fetchMock = mockGraph({ Results: [score()] });

    const result = await svc.getSecureScore('contoso.com', { top: 30 });

    expect(queryOf(fetchMock, '/api/ListGraphRequest').get('$top')).toBe('30');
    expect(queryOf(fetchMock, '/api/ListGraphRequest').get('NoPagination')).toBe('true');
    expect(result.requested).toBe(30);
  });

  it.each([
    ['a non-integer top', { top: 2.5 }],
    ['a top below 1', { top: 0 }],
    ['a top past the 90-day window', { top: 91 }],
  ])('rejects %s before calling CIPP', async (_label, params) => {
    const fetchMock = mockGraph({ Results: [] });

    await expect(svc.getSecureScore('contoso.com', params)).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['allTenants', 'AllTenants', '  alltenants  '])(
    'rejects tenantFilter %p — the estate view is the nightly cache, not this call',
    async (tenantFilter) => {
      const fetchMock = mockGraph({ Results: [] });

      await expect(svc.getSecureScore(tenantFilter)).rejects.toThrow(
        /allTenants is not supported[\s\S]*nightly/
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('returns the newest reading as latest and keeps history newest-first, without control scores on history rows', async () => {
    mockGraph({
      Results: [
        score({
          id: 'score-old',
          createdDateTime: '2026-10-12T00:00:00Z',
          currentScore: 48,
          controlScores: [{ controlName: 'ShouldNotLeak', scoreInPercentage: 1 }],
        }),
        score(),
      ],
    });

    const result = await svc.getSecureScore('contoso.com', { top: 2 });

    expect(result.source).toBe('live');
    expect(result.returned).toBe(2);
    expect(result.latest).toMatchObject({
      id: 'score-new',
      createdDateTime: '2026-10-13T00:00:00Z',
      currentScore: 50,
      maxScore: 100,
      percentage: 50,
      activeUserCount: 40,
      licensedUserCount: 42,
      enabledServices: ['Exchange', 'HasExchange'],
      // Index 0 in the payload is TotalSeats. Match on basis, not position.
      comparedToAllTenants: 55.5,
      comparedToSimilarTenants: 40,
      changeSincePrevious: { points: 2, percentagePoints: 2, days: 1 },
    });
    expect(result.latest?.comparativeScores).toEqual([
      { basis: 'TotalSeats', percentage: 40 },
      { basis: 'AllTenants', percentage: 55.5 },
      { basis: 'IndustryTypes', percentage: 70 },
    ]);
    expect(result.latest?.controls).toMatchObject({
      total: 4,
      completed: 1,
      inProgress: 1,
      notStarted: 1,
      unscored: 1,
    });
    expect(result.latest?.controls.items.map((item) => item.controlName)).toEqual([
      'AdminMFA',
      'TLS',
      'MFARegistration',
      'Mystery',
    ]);
    expect(result.history.map((point) => point.createdDateTime)).toEqual([
      '2026-10-13T00:00:00Z',
      '2026-10-12T00:00:00Z',
    ]);
    expect(result.history[0]).toEqual({
      createdDateTime: '2026-10-13T00:00:00Z',
      currentScore: 50,
      maxScore: 100,
      percentage: 50,
    });
    expect(result.history[1]).not.toHaveProperty('controlScores');
    expect(result.warnings?.[0]).toMatch(/2 most recent/);
  });

  it('accepts a bare array and a single Results object, not only Results arrays', async () => {
    mockGraph([score({ currentScore: 10, maxScore: 40, averageComparativeScores: [] })]);
    const fromArray = await svc.getSecureScore('contoso.com');
    expect(fromArray.latest?.percentage).toBe(25);

    mockGraph({
      Results: score({ currentScore: 1, maxScore: 3, controlScores: [], averageComparativeScores: undefined }),
    });
    const fromObject = await svc.getSecureScore('contoso.com');
    expect(fromObject.latest?.currentScore).toBe(1);
    expect(fromObject.latest?.percentage).toBe(33.33);
    expect(fromObject.latest?.changeSincePrevious).toBeUndefined();
  });

  it('omits the percentage when maxScore is missing or zero, and does not call that zero', async () => {
    mockGraph({
      Results: [score({ currentScore: 10, maxScore: 0, controlScores: [], averageComparativeScores: [] })],
    });

    const result = await svc.getSecureScore('contoso.com');

    expect(result.latest?.percentage).toBeUndefined();
    expect(result.latest?.currentScore).toBe(10);
    expect(result.warnings?.join(' ')).toMatch(/no usable maximum score/);
    expect(result.warnings?.join(' ')).not.toMatch(/most recent readings/);
  });

  it('reports a real zero when currentScore is 0 and the maximum is usable', async () => {
    mockGraph({
      Results: [score({ currentScore: 0, maxScore: 80, controlScores: [], averageComparativeScores: [] })],
    });

    const result = await svc.getSecureScore('contoso.com');

    expect(result.latest?.percentage).toBe(0);
    expect(result.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/no usable maximum score/)])
    );
  });

  it('warns on an empty collection instead of inventing a score of zero', async () => {
    mockGraph({ Results: [null] });

    const result = await svc.getSecureScore('contoso.com');

    expect(result.latest).toBeUndefined();
    expect(result.returned).toBe(0);
    expect(result.history).toEqual([]);
    expect(result.warnings?.join(' ')).toMatch(/not a score of zero/);
  });

  it('throws when CIPP queues the call and returns no rows', async () => {
    mockGraph({ Results: [], Metadata: { Queued: true, QueueMessage: 'Request queued' } });

    await expect(svc.getSecureScore('contoso.com')).rejects.toThrow(/queued the security\/secureScores/);
  });

  it('throws when Results is a failure string under HTTP 200', async () => {
    mockGraph({ Results: ['Failed to retrieve secure score'] });

    await expect(svc.getSecureScore('contoso.com')).rejects.toThrow(/Failed to retrieve secure score/);
  });

  it('names SecurityEvents.Read.All when Graph denies the call', async () => {
    global.fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(
        errorResponse(400, 'Graph Error: Authorization_RequestDenied - Endpoint: security/secureScores')
      )
    ) as unknown as typeof fetch;

    await expect(svc.getSecureScore('contoso.com')).rejects.toThrow(/SecurityEvents\.Read\.All[\s\S]*Upstream said/);
  });

  it('leaves a non-permission Graph error as the CIPP HTTP failure', async () => {
    global.fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(errorResponse(400, 'Graph Error: Resource not found - Endpoint: security/secureScores'))
    ) as unknown as typeof fetch;

    await expect(svc.getSecureScore('contoso.com')).rejects.toThrow(/CIPP API returned HTTP 400/);
    await expect(svc.getSecureScore('contoso.com')).rejects.not.toThrow(/SecurityEvents/);
  });
});

describe('CippService listSecureScoreControls', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs control profiles with a page size of 999 and leaves pagination on', async () => {
    const fetchMock = mockGraph({ Results: [] });

    await svc.listSecureScoreControls('contoso.com');

    const query = queryOf(fetchMock, '/api/ListGraphRequest');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('Endpoint')).toBe('security/secureScoreControlProfiles');
    expect(query.get('$top')).toBe('999');
    expect(query.has('NoPagination')).toBe(false);
    expect([...query.keys()].sort()).toEqual(['$top', 'Endpoint', 'tenantFilter']);
  });

  it.each(['allTenants', 'AllTenants'])('rejects tenantFilter %p before calling CIPP', async (tenantFilter) => {
    const fetchMock = mockGraph({ Results: [] });

    await expect(svc.listSecureScoreControls(tenantFilter)).rejects.toThrow(/allTenants is not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalises profiles, drops Default state updates, and sorts by rank', async () => {
    mockGraph({
      Results: [
        {
          id: 'low',
          title: 'Low rank',
          controlCategory: 'Apps',
          maxScore: 5,
          rank: 2,
          deprecated: false,
          threats: ['Data Exfiltration'],
          controlStateUpdates: [{ state: 'Default', comment: 'noise', updatedDateTime: '2026-01-01T00:00:00Z' }],
        },
        {
          id: 'high',
          title: 'High rank',
          controlCategory: 'Identity',
          service: 'AzureAD',
          maxScore: 10,
          rank: 20,
          deprecated: true,
          implementationCost: 'low',
          userImpact: 'low',
          remediation: 'Turn on MFA',
          actionUrl: 'https://portal.azure.com',
          complianceInformation: [
            {
              certificationName: 'ISO 27001',
              certificationControls: [{ name: 'A.9.2.3' }, 'A.9.4.2'],
            },
          ],
          controlStateUpdates: [
            { state: 'Default', comment: 'ignore me' },
            {
              state: 'Ignored',
              comment: 'Risk accepted',
              updatedBy: 'ada',
              updatedDateTime: '2026-02-01T00:00:00Z',
            },
            {
              state: 'ThirdParty',
              comment: 'Handled elsewhere',
              updatedDateTime: '2026-03-01T00:00:00Z',
            },
          ],
        },
        { id: 'unranked', title: 'No rank' },
      ],
    });

    const result = await svc.listSecureScoreControls('contoso.com');

    expect(result.returned).toBe(3);
    expect(result.deprecated).toBe(1);
    expect(result.controls.map((control) => control.id)).toEqual(['high', 'low', 'unranked']);
    expect(result.controls[0]).toMatchObject({
      title: 'High rank',
      category: 'Identity',
      service: 'AzureAD',
      maxScore: 10,
      rank: 20,
      deprecated: true,
      remediation: 'Turn on MFA',
      compliance: [{ name: 'ISO 27001', controls: ['A.9.2.3', 'A.9.4.2'] }],
    });
    expect(result.controls[0].stateUpdates).toEqual([
      { state: 'ThirdParty', comment: 'Handled elsewhere', updatedDateTime: '2026-03-01T00:00:00Z' },
      { state: 'Ignored', comment: 'Risk accepted', updatedBy: 'ada', updatedDateTime: '2026-02-01T00:00:00Z' },
    ]);
    expect(result.controls[1].stateUpdates).toBeUndefined();
    expect(result.controls[1]).toMatchObject({ deprecated: false, maxScore: 5, threats: ['Data Exfiltration'] });
  });

  it('warns when the catalog is empty instead of calling the tenant fully remediated', async () => {
    mockGraph({ Results: [] });

    const result = await svc.listSecureScoreControls('contoso.com');

    expect(result.controls).toEqual([]);
    expect(result.returned).toBe(0);
    expect(result.warnings?.join(' ')).toMatch(/empty catalog/);
  });
});

describe('Secure Score tool registration', () => {
  it('classifies both tools as read-only security tools', () => {
    for (const name of ['cipp_get_secure_score', 'cipp_list_secure_score_controls'] as const) {
      const tool = TOOL_DEFINITIONS.find((entry) => entry.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.destructiveHint).toBe(false);
      expect(TOOL_CATEGORIES.security).toContain(name);
    }
  });

  it('dispatches cipp_get_secure_score through the handler', async () => {
    mockGraph({ Results: [score()] });
    const handler = new CippToolHandler(service(), logger);

    const result = await handler.handleToolCall('cipp_get_secure_score', {
      tenantFilter: 'contoso.com',
      top: 3,
    });

    const parsed = JSON.parse(result.content[0].text) as { latest: { currentScore: number }; requested: number };
    expect(parsed.requested).toBe(3);
    expect(parsed.latest.currentScore).toBe(50);
  });
});
