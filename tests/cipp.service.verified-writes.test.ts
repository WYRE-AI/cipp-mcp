// The point of these suites: CIPP answers "did I accept the job?", not "did the
// change land?". Every verified write therefore has to distinguish three
// outcomes — confirmed, pending, failed — and the one that matters most is the
// middle case: CIPP returned a clean HTTP 200 and the change is NOT there.

import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { bodyOf, jsonResponse, queryOf } from './helpers.js';

const logger = new Logger('error');

const UPN = 'alice@contoso.com';
const OBJECT_ID = '11111111-1111-1111-1111-111111111111';

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

/**
 * Route CIPP requests by endpoint. `resolve` answers the UPN lookup that every
 * verified write starts with; `readback` answers the by-id reads the
 * verification loop issues, and is called once per poll so a suite can make the
 * record change (or refuse to) partway through.
 */
function mockCipp(routes: {
  readback?: () => unknown;
  write: Record<string, unknown>;
  writeEndpoint: string;
}): FetchMock {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
    if (url.includes('/api/ListUsers')) {
      const isReadback = new URL(url).searchParams.has('UserID');
      if (isReadback && routes.readback) {
        return Promise.resolve(jsonResponse([routes.readback()]));
      }
      return Promise.resolve(jsonResponse([{ id: OBJECT_ID, userPrincipalName: UPN }]));
    }
    if (url.includes(`/api/${routes.writeEndpoint}`)) {
      return Promise.resolve(jsonResponse(routes.write));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/**
 * Drive the verification poll loop to completion under fake timers, so a
 * `pending` outcome costs no real wall-clock time.
 */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 40 && !done; i++) {
    await jest.advanceTimersByTimeAsync(3_000);
  }
  return promise;
}

function newService(): CippService {
  return new CippService(
    { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
    logger
  );
}

describe('disableUser verification', () => {
  let svc: CippService;

  beforeEach(() => {
    jest.useFakeTimers();
    svc = newService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('confirms the disable when the readback shows accountEnabled=false', async () => {
    mockCipp({
      writeEndpoint: 'ExecDisableUser',
      write: { Results: ['Disabled user alice@contoso.com'] },
      readback: () => ({ id: OBJECT_ID, userPrincipalName: UPN, accountEnabled: false }),
    });

    const result = await settle(svc.disableUser('contoso.com', UPN));

    expect(result.status).toBe('confirmed');
    expect(result.verifiedBy).toBe('accountEnabled');
    expect(result.recheck).toBeNull();
    expect(result.message).toMatch(/confirmed by readback/i);
  });

  // The case this whole change exists for.
  it('reports pending — never success — when CIPP acknowledges but the account is still enabled', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecDisableUser',
      // A clean, cheerful acknowledgement. It proves nothing.
      write: { Results: ['Disabled user alice@contoso.com'] },
      readback: () => ({ id: OBJECT_ID, userPrincipalName: UPN, accountEnabled: true }),
    });

    const result = await settle(svc.disableUser('contoso.com', UPN));

    expect(result.status).toBe('pending');
    expect(result.recheck).toMatch(/re-read the account/i);
    expect(result.message).toMatch(/do not report this to the caller as done/i);
    expect(result.message).not.toMatch(/confirmed/i);
    // It polled rather than giving up after one look.
    const readbacks = fetchMock.mock.calls.filter(([url]) =>
      url.includes('/api/ListUsers') && url.includes('UserID')
    );
    expect(readbacks.length).toBeGreaterThan(1);
  });

  it('confirms once a lagging readback catches up, without waiting out the whole budget', async () => {
    let polls = 0;
    mockCipp({
      writeEndpoint: 'ExecDisableUser',
      write: { Results: ['Disabled user alice@contoso.com'] },
      readback: () => ({
        id: OBJECT_ID,
        userPrincipalName: UPN,
        // Entra reflects the change on the third read.
        accountEnabled: ++polls < 3,
      }),
    });

    const result = await settle(svc.disableUser('contoso.com', UPN));

    expect(result.status).toBe('confirmed');
    expect(polls).toBe(3);
  });

  it('reports failed, and skips the readback entirely, when CIPP reports a failure inside its HTTP 200', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecDisableUser',
      write: { Results: ['Failed to disable user: Insufficient privileges'] },
      readback: () => ({ id: OBJECT_ID, userPrincipalName: UPN, accountEnabled: false }),
    });

    const result = await settle(svc.disableUser('contoso.com', UPN));

    expect(result.status).toBe('failed');
    expect(result.failures).toEqual(['Failed to disable user: Insufficient privileges']);
    expect(result.recheck).not.toBeNull();
    const readbacks = fetchMock.mock.calls.filter(([url]) =>
      url.includes('/api/ListUsers') && url.includes('UserID')
    );
    expect(readbacks).toHaveLength(0);
  });

  it('treats a failing readback as unconfirmed, not as a failed write', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers') && url.includes('UserID')) {
        throw new Error('CIPP read timed out');
      }
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([{ id: OBJECT_ID, userPrincipalName: UPN }]));
      }
      return Promise.resolve(jsonResponse({ Results: ['Disabled user alice@contoso.com'] }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await settle(svc.disableUser('contoso.com', UPN));

    expect(result.status).toBe('pending');
    expect(result.failures).toEqual([]);
  });

  it('sends the resolved object id, because accountEnabled only comes back on the by-id read', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecDisableUser',
      write: { Results: ['Disabled user alice@contoso.com'] },
      readback: () => ({ id: OBJECT_ID, userPrincipalName: UPN, accountEnabled: false }),
    });

    await settle(svc.disableUser('contoso.com', UPN));

    expect(bodyOf(fetchMock, 'ExecDisableUser').ID).toBe(OBJECT_ID);
    const readback = fetchMock.mock.calls.find(
      ([url]) => url.includes('/api/ListUsers') && url.includes('UserID')
    )!;
    expect(new URL(readback[0]).searchParams.get('UserID')).toBe(OBJECT_ID);
  });
});

describe('resetPassword verification', () => {
  let svc: CippService;

  beforeEach(() => {
    jest.useFakeTimers();
    svc = newService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('confirms the reset when lastPasswordChangeDateTime advances past its own prior value', async () => {
    let reads = 0;
    mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Successfully reset password for alice@contoso.com'] },
      readback: () => ({
        id: OBJECT_ID,
        // First read is the pre-write baseline; later reads show the advance.
        lastPasswordChangeDateTime:
          ++reads === 1 ? '2026-01-01T00:00:00Z' : '2026-09-11T10:00:00Z',
      }),
    });

    const result = await settle(svc.resetPassword('contoso.com', UPN));

    expect(result.status).toBe('confirmed');
    expect(result.verifiedBy).toBe('lastPasswordChangeDateTime');
  });

  it('reports pending when CIPP acknowledges but the password timestamp never moves', async () => {
    mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Successfully reset password for alice@contoso.com'] },
      readback: () => ({ id: OBJECT_ID, lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' }),
    });

    const result = await settle(svc.resetPassword('contoso.com', UPN));

    expect(result.status).toBe('pending');
    expect(result.message).not.toMatch(/confirmed/i);
    expect(result.recheck).toMatch(/lastPasswordChangeDateTime/);
  });

  it('stays pending rather than guessing when the account has no readable baseline', async () => {
    mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Successfully reset password for alice@contoso.com'] },
      readback: () => ({ id: OBJECT_ID }),
    });

    const result = await settle(svc.resetPassword('contoso.com', UPN));

    expect(result.status).toBe('pending');
  });

  it('reports failed when CIPP reports the reset failed inside its HTTP 200', async () => {
    mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Could not reset password: password does not meet complexity rules'] },
      readback: () => ({ id: OBJECT_ID, lastPasswordChangeDateTime: '2026-09-11T10:00:00Z' }),
    });

    const result = await settle(svc.resetPassword('contoso.com', UPN));

    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
  });

  it('does not mistake a generated password containing "fail" for a failure', async () => {
    let reads = 0;
    mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['New password: Xfail7Quartz!'] },
      readback: () => ({
        id: OBJECT_ID,
        lastPasswordChangeDateTime:
          ++reads === 1 ? '2026-01-01T00:00:00Z' : '2026-09-11T10:00:00Z',
      }),
    });

    const result = await settle(svc.resetPassword('contoso.com', UPN));

    expect(result.status).toBe('confirmed');
    expect(result.failures).toEqual([]);
  });

  it('sends the resolved object id, the display name and the MustChange flag', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Successfully reset password'] },
      readback: () => ({ id: OBJECT_ID, lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' }),
    });

    await settle(svc.resetPassword('contoso.com', UPN, { mustChangeAtNextSignIn: true }));

    const body = bodyOf(fetchMock, 'ExecResetPass');
    expect(body.ID).toBe(OBJECT_ID);
    expect(body.displayName).toBe(UPN);
    expect(body.MustChange).toBe(true);
  });

  it('sends MustChange=false rather than omitting it, because CIPP has no default', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Successfully reset password'] },
      readback: () => ({ id: OBJECT_ID, lastPasswordChangeDateTime: '2026-01-01T00:00:00Z' }),
    });

    await settle(svc.resetPassword('contoso.com', UPN));

    expect(bodyOf(fetchMock, 'ExecResetPass').MustChange).toBe(false);
  });

  // Reporting a password the tenant never set would be the worst failure this
  // tool could have, so a caller-chosen password is refused before any request.
  it('refuses a caller-chosen password instead of silently dropping it', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecResetPass',
      write: { Results: ['Successfully reset password'] },
    });

    await expect(
      svc.resetPassword('contoso.com', UPN, { newPassword: 'Sup3rSecret!' })
    ).rejects.toThrow(/does not accept a chosen password/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resetMFA verification', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = newService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('confirms from the inline result when CIPP reports the removal', async () => {
    mockCipp({
      writeEndpoint: 'ExecResetMFA',
      write: { Results: ['Successfully removed MFA methods for alice@contoso.com'] },
    });

    const result = await svc.resetMFA('contoso.com', OBJECT_ID);

    expect(result.status).toBe('confirmed');
    expect(result.recheck).toBeNull();
  });

  // Invoke-ExecResetMFA forwards the body's ID as -UserPrincipalName, so a
  // GUID has to be resolved to a UPN first or the call targets nothing.
  it('resolves an object id to a UPN, because this endpoint addresses the account by UPN', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecResetMFA',
      write: { Results: ['Successfully removed MFA methods for alice@contoso.com'] },
    });

    await svc.resetMFA('contoso.com', OBJECT_ID);

    expect(bodyOf(fetchMock, 'ExecResetMFA').ID).toBe(UPN);
  });

  it('reports pending, not success, when CIPP returns an empty body that proves nothing', async () => {
    mockCipp({ writeEndpoint: 'ExecResetMFA', write: {} });

    const result = await svc.resetMFA('contoso.com', OBJECT_ID);

    expect(result.status).toBe('pending');
    expect(result.message).not.toMatch(/confirmed|completed the removal/i);
    expect(result.recheck).toMatch(/before telling anyone MFA was reset/i);
  });

  it('reports failed when CIPP reports a failure inside its HTTP 200', async () => {
    mockCipp({
      writeEndpoint: 'ExecResetMFA',
      write: { Results: 'Unable to remove MFA methods: user not found' },
    });

    const result = await svc.resetMFA('contoso.com', OBJECT_ID);

    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
    expect(result.message).toMatch(/do not report this to the caller as done/i);
  });
});

describe('revokeSessions verification', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = newService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends Username alongside ID so CIPP names the account in its own result', async () => {
    const fetchMock = mockCipp({
      writeEndpoint: 'ExecRevokeSessions',
      write: { Results: ['Successfully revoked sessions for alice@contoso.com'] },
    });

    const result = await svc.revokeSessions('contoso.com', OBJECT_ID);

    const body = bodyOf(fetchMock, 'ExecRevokeSessions');
    // Lowercase `id` is the spelling Invoke-ExecRevokeSessions actually reads.
    expect(body.id).toBe(OBJECT_ID);
    expect(body.Username).toBe(UPN);
    expect(result.status).toBe('confirmed');
    // Resolution is a narrow by-id lookup, not a tenant dump.
    expect(queryOf(fetchMock, 'ListUsers').get('UserID')).toBe(OBJECT_ID);
  });

  it('reports pending, not success, when CIPP returns nothing to read', async () => {
    mockCipp({ writeEndpoint: 'ExecRevokeSessions', write: {} });

    const result = await svc.revokeSessions('contoso.com', OBJECT_ID);

    expect(result.status).toBe('pending');
    expect(result.message).not.toMatch(/revoked for/i);
  });

  it('reports failed when CIPP reports a failure inside its HTTP 200', async () => {
    mockCipp({
      writeEndpoint: 'ExecRevokeSessions',
      write: { Results: ['Failed to revoke sessions: Request_ResourceNotFound'] },
    });

    const result = await svc.revokeSessions('contoso.com', OBJECT_ID);

    expect(result.status).toBe('failed');
  });
});

describe('createUser verification', () => {
  let svc: CippService;

  /**
   * `createUser` verifies through the SEARCH path of ListUsers (a graphFilter
   * query), not the by-id path, so this mock routes on that instead.
   */
  function mockCreate(opts: { write: Record<string, unknown>; found: boolean }): FetchMock {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse(opts.found ? [{ id: OBJECT_ID, userPrincipalName: UPN }] : [])
        );
      }
      if (url.includes('/api/AddUser')) {
        return Promise.resolve(jsonResponse(opts.write));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    svc = newService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('confirms the create once the account is visible in the tenant', async () => {
    mockCreate({ write: { Results: [`Created user ${UPN}`] }, found: true });

    const result = await settle(
      svc.createUser('contoso.com', { displayName: 'Alice', userPrincipalName: UPN })
    );

    expect(result.status).toBe('confirmed');
    expect(result.recheck).toBeNull();
  });

  // The acknowledged-but-not-applied case again: CIPP said yes, Entra has no
  // such account.
  it('reports pending when CIPP acknowledges but the account never appears', async () => {
    mockCreate({ write: { Results: [`Created user ${UPN}`] }, found: false });

    const result = await settle(
      svc.createUser('contoso.com', { displayName: 'Alice', userPrincipalName: UPN })
    );

    expect(result.status).toBe('pending');
    expect(result.message).toMatch(/do not report this to the caller as done/i);
    expect(result.recheck).toMatch(/before telling anyone the account exists/i);
  });

  it('reports failed when CIPP reports the create failed inside its HTTP 200', async () => {
    mockCreate({
      write: { Results: ['Failed to create user: a user with this UPN already exists'] },
      found: true,
    });

    const result = await settle(
      svc.createUser('contoso.com', { displayName: 'Alice', userPrincipalName: UPN })
    );

    expect(result.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
  });

  // New-CippUser builds the UPN from separate halves and never reads a whole
  // userPrincipalName, so passing one through would post "@" to Graph.
  it('splits the UPN into the username and Domain halves CIPP actually reads', async () => {
    const fetchMock = mockCreate({ write: { Results: [`Created user ${UPN}`] }, found: true });

    await settle(svc.createUser('contoso.com', { displayName: 'Alice', userPrincipalName: UPN }));

    const body = bodyOf(fetchMock, 'AddUser');
    expect(body.username).toBe('alice');
    expect(body.Domain).toBe('contoso.com');
    expect(body.userPrincipalName).toBeUndefined();
  });

  it('refuses a partial UPN rather than letting CIPP post an empty address', async () => {
    const fetchMock = mockCreate({ write: {}, found: false });

    await expect(
      svc.createUser('contoso.com', { displayName: 'Alice', userPrincipalName: 'alice' })
    ).rejects.toThrow(/must be a full UPN/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createGroup input shaping', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = newService();
    global.fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ Results: ['Created group'] }))
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a groupType CIPP does not know, instead of an opaque HTTP 500', async () => {
    await expect(
      svc.createGroup('contoso.com', {
        displayName: 'Finance',
        // Graph's vocabulary, not CIPP's — CIPP calls groupType.ToLower() blind.
        groupType: 'Unified' as never,
      })
    ).rejects.toThrow(/groupType must be one of/i);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('requires a mail alias for the mail-enabled group types', async () => {
    await expect(
      svc.createGroup('contoso.com', { displayName: 'Finance', groupType: 'M365' })
    ).rejects.toThrow(/mail-enabled/i);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends primDomain as the { value } object CIPP dereferences', async () => {
    const fetchMock = global.fetch as unknown as FetchMock;

    await svc.createGroup('contoso.com', {
      displayName: 'Finance',
      groupType: 'M365',
      username: 'finance-team',
      primDomain: 'contoso.com',
    });

    const body = bodyOf(fetchMock, 'AddGroup');
    expect(body.groupType).toBe('M365');
    expect(body.username).toBe('finance-team');
    expect(body.primDomain).toEqual({ value: 'contoso.com' });
  });

  it('creates a plain Entra security group ("Generic") without a mail alias', async () => {
    const fetchMock = global.fetch as unknown as FetchMock;

    await svc.createGroup('contoso.com', { displayName: 'CA-Exclusions', groupType: 'Generic' });

    const body = bodyOf(fetchMock, 'AddGroup');
    expect(body.groupType).toBe('Generic');
    expect(body.username).toBeUndefined();
  });
});
