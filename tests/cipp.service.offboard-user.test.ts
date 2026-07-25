import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse, bodyOf, calledEndpoint } from './helpers.js';

const logger = new Logger('error');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const UPN = 'alice@contoso.com';

// Regression guard for #72: the outbound body must carry a non-empty `user`
// array of { value } objects plus at least one action from CIPP's own list.
// The old payload (`ID` + four invented option names) matched nothing, and
// because ExecOffboardUser returns 200 on task creation, it reported success
// while running no offboarding actions at all.
describe('CippService offboardUser', () => {
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

  function mockCipp(offboardResults: unknown = ['Offboarding job started for alice@contoso.com']) {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([{ id: USER_ID, userPrincipalName: UPN }]));
      }
      if (url.includes('/api/ExecOffboardUser')) {
        return Promise.resolve(jsonResponse({ Results: offboardResults }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('sends user as a non-empty array of { value } objects, never a scalar ID', async () => {
    const fetchMock = mockCipp();

    await svc.offboardUser('contoso.com', USER_ID, { RemoveLicenses: true });

    const body = bodyOf(fetchMock, '/api/ExecOffboardUser');
    expect(body.user).toEqual([{ value: UPN }]);
    expect(body.ID).toBeUndefined();
    expect(body.tenantFilter).toBe('contoso.com');
  });

  it('resolves an object id to the current UPN before queueing', async () => {
    const fetchMock = mockCipp();

    await svc.offboardUser('contoso.com', USER_ID, { DisableSignIn: true });

    const user = bodyOf(fetchMock, '/api/ExecOffboardUser').user as Array<{ value: string }>;
    expect(user[0]!.value).toBe(UPN);
  });

  it('carries at least one action from CIPP\'s recognised list', async () => {
    const fetchMock = mockCipp();

    await svc.offboardUser('contoso.com', UPN, {
      RemoveLicenses: true,
      RevokeSessions: true,
      DisableSignIn: true,
    });

    const body = bodyOf(fetchMock, '/api/ExecOffboardUser');
    expect(body.RemoveLicenses).toBe(true);
    expect(body.RevokeSessions).toBe(true);
    expect(body.DisableSignIn).toBe(true);
  });

  it('drops the old invented option names rather than sending them', async () => {
    const fetchMock = mockCipp();

    await svc.offboardUser('contoso.com', UPN, {
      revokePermissions: true,
      disableUser: true,
      resetPassword: true,
      transferMailbox: 'bob@contoso.com',
      RemoveGroups: true,
    });

    const body = bodyOf(fetchMock, '/api/ExecOffboardUser');
    expect(body.revokePermissions).toBeUndefined();
    expect(body.disableUser).toBeUndefined();
    expect(body.resetPassword).toBeUndefined();
    expect(body.transferMailbox).toBeUndefined();
    expect(body.RemoveGroups).toBe(true);
  });

  it('refuses an empty action set instead of queueing a silent no-op', async () => {
    const fetchMock = mockCipp();

    await expect(svc.offboardUser('contoso.com', UPN, {})).rejects.toBeInstanceOf(McpError);
    expect(calledEndpoint(fetchMock, '/api/ExecOffboardUser')).toBe(false);
  });

  it('treats false-valued actions as unselected', async () => {
    const fetchMock = mockCipp();

    await expect(
      svc.offboardUser('contoso.com', UPN, { RemoveLicenses: false, DeleteUser: false })
    ).rejects.toThrow(/no offboarding actions/i);
    expect(calledEndpoint(fetchMock, '/api/ExecOffboardUser')).toBe(false);
  });

  it('sends forward as a { value } object with KeepCopy alongside it', async () => {
    const fetchMock = mockCipp();

    await svc.offboardUser('contoso.com', UPN, { forward: 'bob@contoso.com', KeepCopy: true });

    const body = bodyOf(fetchMock, '/api/ExecOffboardUser');
    expect(body.forward).toEqual({ value: 'bob@contoso.com' });
    expect(body.KeepCopy).toBe(true);
  });

  it('passes mailbox and OneDrive access collections through as arrays', async () => {
    const fetchMock = mockCipp();

    await svc.offboardUser('contoso.com', UPN, {
      AccessAutomap: ['bob@contoso.com'],
      OnedriveAccess: ['carol@contoso.com'],
      AccessNoAutomap: [],
    });

    const body = bodyOf(fetchMock, '/api/ExecOffboardUser');
    expect(body.AccessAutomap).toEqual(['bob@contoso.com']);
    expect(body.OnedriveAccess).toEqual(['carol@contoso.com']);
    expect(body.AccessNoAutomap).toBeUndefined();
  });

  it('reports queued — not offboarded — on success', async () => {
    mockCipp();

    const result = (await svc.offboardUser('contoso.com', UPN, { DeleteUser: true })) as {
      status: string;
      message: string;
      actions: string[];
    };

    expect(result.status).toBe('queued');
    expect(result.actions).toEqual(['DeleteUser']);
    expect(result.message).toMatch(/queued/i);
  });

  it('reports failure when CIPP returns an error string under HTTP 200', async () => {
    mockCipp(['Error - Could not add task: something blew up']);

    const result = (await svc.offboardUser('contoso.com', UPN, { RemoveLicenses: true })) as {
      status: string;
      failures: string[];
    };

    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
  });

  it('refuses to offboard when the user cannot be resolved', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.offboardUser('contoso.com', USER_ID, { DeleteUser: true })
    ).rejects.toBeInstanceOf(McpError);
    expect(calledEndpoint(fetchMock, '/api/ExecOffboardUser')).toBe(false);
  });
});
