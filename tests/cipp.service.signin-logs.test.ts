import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse, errorResponse, queryOf, calledEndpoint } from './helpers.js';

const logger = new Logger('error');

function service(): CippService {
  return new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

// ---------------------------------------------------------------------------
// /api/ListUserSigninLogs
//
// Invoke-ListUserSigninLogs reads tenantFilter, UserID and top, and builds
// Graph's `auditLogs/signIns?$filter=(userId eq '<UserID>')&$top=<top>`.
// Graph's userId is the Entra object id — a UPN matches nothing and returns an
// empty page — so the service resolves the user through ListUsers first.
// On failure upstream answers HTTP 500 with
// `["Failed to retrieve Sign In report for user <id> : Error: <reason>"]`.
// ---------------------------------------------------------------------------
describe('CippService listUserSigninLogs', () => {
  let svc: CippService;
  const OBJECT_ID = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockCipp(signIns: () => Response, users: unknown = [
    { id: OBJECT_ID, userPrincipalName: 'alice@contoso.com' },
  ]): FetchMock {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUserSigninLogs')) return Promise.resolve(signIns());
      if (url.includes('/api/ListUsers')) return Promise.resolve(jsonResponse(users));
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  /** A Graph beta signIn object, trimmed to the fields the tool reads. */
  function signIn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'aaaa-1',
      createdDateTime: '2026-09-24T10:00:00Z',
      userId: OBJECT_ID,
      userPrincipalName: 'alice@contoso.com',
      appDisplayName: 'Office 365 Exchange Online',
      resourceDisplayName: 'Office 365 Exchange Online',
      ipAddress: '203.0.113.7',
      clientAppUsed: 'Browser',
      correlationId: 'corr-1',
      conditionalAccessStatus: 'success',
      isInteractive: true,
      authenticationRequirement: 'multiFactorAuthentication',
      riskLevelDuringSignIn: 'none',
      riskState: 'none',
      riskDetail: 'none',
      status: { errorCode: 0, failureReason: 'Other.', additionalDetails: 'MFA completed in Azure AD' },
      location: { city: 'Chattanooga', state: 'Tennessee', countryOrRegion: 'US' },
      deviceDetail: {
        displayName: 'ALICE-LAPTOP',
        operatingSystem: 'Windows10',
        browser: 'Edge 128.0.0',
        isCompliant: true,
        isManaged: true,
        trustType: 'Azure AD joined',
      },
      appliedConditionalAccessPolicies: [
        { displayName: 'Require MFA', result: 'success' },
        { displayName: 'Block legacy auth', result: 'notApplied' },
      ],
      authenticationDetails: [
        { authenticationMethod: 'Password', succeeded: true, authenticationStepResultDetail: 'Correct password' },
        {
          authenticationMethod: 'Mobile app notification',
          succeeded: true,
          authenticationStepResultDetail: 'MFA successfully completed',
        },
      ],
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Query-string shape
  // -------------------------------------------------------------------------

  it('resolves a UPN to the object id and sends exactly tenantFilter, UserID and top', async () => {
    const fetchMock = mockCipp(() => jsonResponse([signIn()]));

    await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com');

    const lookup = queryOf(fetchMock, '/api/ListUsers');
    expect(lookup.get('graphFilter')).toBe("userPrincipalName eq 'alice@contoso.com'");

    const query = queryOf(fetchMock, '/api/ListUserSigninLogs');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('UserID')).toBe(OBJECT_ID);
    // Upstream's own default, sent explicitly so the request is unambiguous.
    expect(query.get('top')).toBe('50');
    expect([...query.keys()].sort()).toEqual(['UserID', 'tenantFilter', 'top']);
  });

  it('verifies an object id exists before querying, and forwards top', async () => {
    const fetchMock = mockCipp(() => jsonResponse([signIn()]));

    const result = await svc.listUserSigninLogs('contoso.com', OBJECT_ID, { top: 200 });

    expect(queryOf(fetchMock, '/api/ListUsers').get('UserID')).toBe(OBJECT_ID);
    expect(queryOf(fetchMock, '/api/ListUserSigninLogs').get('top')).toBe('200');
    expect(result.userPrincipalName).toBe('alice@contoso.com');
    expect(result.requested).toBe(200);
  });

  it.each([
    ['a non-integer top', { top: 2.5 }],
    ['a top below 1', { top: 0 }],
    ['a top above the Graph page cap', { top: 1001 }],
  ])('rejects %s before calling CIPP', async (_label, params) => {
    const fetchMock = mockCipp(() => jsonResponse([]));

    await expect(svc.listUserSigninLogs('contoso.com', OBJECT_ID, params)).rejects.toBeInstanceOf(
      McpError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['allTenants', 'AllTenants', '  alltenants  '])(
    'rejects tenantFilter %p — upstream has no all-tenants branch',
    async (tenantFilter) => {
      const fetchMock = mockCipp(() => jsonResponse([]));

      await expect(svc.listUserSigninLogs(tenantFilter, 'alice@contoso.com')).rejects.toThrow(
        /allTenants is not supported[\s\S]*ListSignIns/
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  // An unknown user must not reach the sign-in endpoint: the empty page it
  // would get back reads as "this user never signs in".
  it('refuses an unresolvable user instead of reporting no sign-ins', async () => {
    const fetchMock = mockCipp(() => jsonResponse([]), []);

    await expect(svc.listUserSigninLogs('contoso.com', 'ghost@contoso.com')).rejects.toThrow(
      /Entra object id/
    );
    expect(calledEndpoint(fetchMock, '/api/ListUserSigninLogs')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Row shape
  // -------------------------------------------------------------------------

  it('flattens a Graph sign-in into a practical row', async () => {
    mockCipp(() => jsonResponse([signIn()]));

    const result = await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com');
    const row = result.signIns[0];

    expect(row).toEqual({
      time: '2026-09-24T10:00:00Z',
      app: 'Office 365 Exchange Online',
      resource: 'Office 365 Exchange Online',
      ipAddress: '203.0.113.7',
      location: 'Chattanooga, Tennessee, US',
      status: 'success',
      errorCode: 0,
      failureReason: undefined,
      additionalDetails: 'MFA completed in Azure AD',
      clientApp: 'Browser',
      conditionalAccessStatus: 'success',
      conditionalAccessPolicies: [{ name: 'Require MFA', result: 'success' }],
      authenticationRequirement: 'multiFactorAuthentication',
      authentication: {
        methods: ['Password', 'Mobile app notification'],
        steps: [
          { method: 'Password', succeeded: true, detail: 'Correct password' },
          {
            method: 'Mobile app notification',
            succeeded: true,
            detail: 'MFA successfully completed',
          },
        ],
      },
      device: {
        name: 'ALICE-LAPTOP',
        operatingSystem: 'Windows10',
        browser: 'Edge 128.0.0',
        isCompliant: true,
        isManaged: true,
        trustType: 'Azure AD joined',
      },
      risk: undefined,
      isInteractive: true,
      userAgent: undefined,
      correlationId: 'corr-1',
      id: 'aaaa-1',
    });
  });

  it('reports a failed sign-in with its error code, reason and flagged risk', async () => {
    mockCipp(() =>
      jsonResponse([
        signIn({
          status: { errorCode: 50126, failureReason: 'Invalid username or password.' },
          conditionalAccessStatus: 'notApplied',
          appliedConditionalAccessPolicies: [],
          authenticationDetails: [],
          mfaDetail: null,
          riskLevelDuringSignIn: 'high',
          riskState: 'atRisk',
          riskDetail: 'none',
          location: { countryOrRegion: 'RU' },
        }),
      ])
    );

    const result = await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com');
    const row = result.signIns[0];

    expect(row.status).toBe('failure');
    expect(row.errorCode).toBe(50126);
    expect(row.failureReason).toBe('Invalid username or password.');
    expect(row.location).toBe('RU');
    expect(row.conditionalAccessPolicies).toBeUndefined();
    expect(row.authentication).toBeUndefined();
    expect(row.risk).toEqual({ level: 'high', state: 'atRisk' });
  });

  it('falls back to the legacy mfaDetail block when there are no auth steps', async () => {
    mockCipp(() =>
      jsonResponse([
        signIn({
          authenticationDetails: undefined,
          mfaDetail: { authMethod: 'PhoneAppNotification', authDetail: '+X XXXXXXXX12' },
        }),
      ])
    );

    const result = await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com');

    expect(result.signIns[0].authentication).toEqual({
      methods: ['PhoneAppNotification'],
      detail: '+X XXXXXXXX12',
    });
  });

  it('summarises successes, failures, distinct IPs and countries', async () => {
    mockCipp(() =>
      jsonResponse([
        signIn({ createdDateTime: '2026-09-24T10:00:00Z' }),
        signIn({
          createdDateTime: '2026-09-23T08:00:00Z',
          ipAddress: '198.51.100.9',
          status: { errorCode: 50126 },
          location: { countryOrRegion: 'NL' },
        }),
        signIn({ createdDateTime: '2026-09-22T07:00:00Z' }),
      ])
    );

    const result = await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com');

    expect(result.returned).toBe(3);
    expect(result.summary).toEqual({
      successful: 2,
      failed: 1,
      distinctIpAddresses: 2,
      countries: ['NL', 'US'],
      newest: '2026-09-24T10:00:00Z',
      oldest: '2026-09-22T07:00:00Z',
    });
    expect(result.warnings).toBeUndefined();
  });

  it('warns that older sign-ins may exist when the page fills top', async () => {
    mockCipp(() => jsonResponse([signIn(), signIn()]));

    const result = await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com', { top: 2 });

    expect(result.warnings).toEqual([expect.stringMatching(/older sign-ins may exist/)]);
  });

  // -------------------------------------------------------------------------
  // Empty result
  // -------------------------------------------------------------------------

  // An empty Graph page reaches the handler as $null, and `Body = @($Result)`
  // wraps that as a one-element array — so `[null]` is the empty case too.
  it.each([
    ['[]', []],
    ['[null]', [null]],
  ])('treats %s as no sign-ins, with a warning explaining why', async (_label, body) => {
    mockCipp(() => jsonResponse(body));

    const result = await svc.listUserSigninLogs('contoso.com', 'alice@contoso.com');

    expect(result.returned).toBe(0);
    expect(result.signIns).toEqual([]);
    expect(result.summary.successful).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.newest).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringMatching(/No interactive sign-ins[\s\S]*30 days[\s\S]*non-interactive/),
    ]);
  });

  // -------------------------------------------------------------------------
  // Upstream errors
  // -------------------------------------------------------------------------

  it('surfaces the upstream 500 failure string', async () => {
    mockCipp(() =>
      errorResponse(
        500,
        JSON.stringify([
          `Failed to retrieve Sign In report for user ${OBJECT_ID} : Error: Insufficient privileges to complete the operation.`,
        ])
      )
    );

    await expect(svc.listUserSigninLogs('contoso.com', 'alice@contoso.com')).rejects.toThrow(
      /HTTP 500[\s\S]*Failed to retrieve Sign In report[\s\S]*Insufficient privileges/
    );
  });

  it('names the licence gap when Graph refuses a non-premium tenant', async () => {
    mockCipp(() =>
      errorResponse(
        500,
        JSON.stringify([
          `Failed to retrieve Sign In report for user ${OBJECT_ID} : Error: Neither tenant is B2C or tenant doesn't have premium license`,
        ])
      )
    );

    await expect(svc.listUserSigninLogs('contoso.com', 'alice@contoso.com')).rejects.toThrow(
      /Entra ID P1 or P2/
    );
  });

  it('names the licence gap from the bare Graph error code', async () => {
    mockCipp(() =>
      errorResponse(
        500,
        JSON.stringify([
          `Failed to retrieve Sign In report for user ${OBJECT_ID} : Error: Authentication_RequestFromNonPremiumTenantOrB2CTenant`,
        ])
      )
    );

    await expect(svc.listUserSigninLogs('contoso.com', 'alice@contoso.com')).rejects.toThrow(
      /Entra ID P1 or P2/
    );
  });

  // The error message embeds the request URL, tenantFilter included, so a
  // tenant domain containing "premium" must not turn every 500 into a licence gap.
  it('does not blame licensing for an unrelated 500 from a tenant named premium-something', async () => {
    mockCipp(() =>
      errorResponse(
        500,
        JSON.stringify([
          `Failed to retrieve Sign In report for user ${OBJECT_ID} : Error: Insufficient privileges to complete the operation.`,
        ])
      )
    );

    const err = await svc
      .listUserSigninLogs('premiumfoods.com', 'alice@contoso.com')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as Error).message).toMatch(/Insufficient privileges/);
    expect((err as Error).message).not.toMatch(/P1 or P2/);
  });

  // Never let "CIPP returned 200" mean success: a string where records belong
  // is upstream failure text.
  it('refuses a 200 whose body is a message rather than sign-in records', async () => {
    mockCipp(() =>
      jsonResponse([`Failed to retrieve Sign In report for user ${OBJECT_ID} : Error: timeout`])
    );

    const err = (await svc
      .listUserSigninLogs('contoso.com', 'alice@contoso.com')
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(
      new RegExp(`returned a message instead of sign-in records for user ${OBJECT_ID}[\\s\\S]*timeout`)
    );
    // The object id identifies the user; the UPN (customer PII) stays out of errors.
    expect(err.message).not.toMatch(/alice@contoso\.com/);
  });
});
