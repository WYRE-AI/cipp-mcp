import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService, CippHttpError } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { withNoLookupDelay } from './helpers.js';

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

describe('CippService editUser', () => {
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

  it('splits username + Domain from the resolved identity when editing by GUID', async () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url, init) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([{ id: userId, userPrincipalName: 'alice@contoso.com' }]));
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url} ${init.method}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser('contoso.com', userId, { displayName: 'Alice Smith' });

    const [, editInit] = fetchMock.mock.calls.find(([u]) => u.includes('/api/EditUser'))!;
    const body = JSON.parse(editInit.body as string);
    expect(body.id).toBe(userId);
    expect(body.username).toBe('alice');
    expect(body.Domain).toBe('contoso.com');
    expect(body.userPrincipalName).toBeUndefined();
  });

  it('looks up a UPN via graphFilter without searchField/searchValue or an unfiltered tenant list', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser('contoso.com', 'alice@contoso.com', { displayName: 'Alice Smith' });

    const [listUrl] = fetchMock.mock.calls.find(([u]) => u.includes('/api/ListUsers'))!;
    const parsed = new URL(listUrl);
    expect(parsed.searchParams.get('tenantFilter')).toBe('contoso.com');
    expect(parsed.searchParams.get('graphFilter')).toBe(
      "userPrincipalName eq 'alice@contoso.com'"
    );
    expect(parsed.searchParams.get('searchField')).toBeNull();
    expect(parsed.searchParams.get('searchValue')).toBeNull();
    expect(parsed.search).toContain('graphFilter=');
  });

  it('escapes single quotes inside the UPN graphFilter', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: "o'connor@contoso.com" }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser('contoso.com', "o'connor@contoso.com", { displayName: "O'Connor" });

    const [listUrl] = fetchMock.mock.calls.find(([u]) => u.includes('/api/ListUsers'))!;
    const parsed = new URL(listUrl);
    expect(parsed.searchParams.get('graphFilter')).toBe(
      "userPrincipalName eq 'o''connor@contoso.com'"
    );
  });

  it('refuses to guess when the user cannot be resolved and does not PATCH', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      withNoLookupDelay(svc).editUser('contoso.com', '11111111-1111-1111-1111-111111111111', {
        displayName: 'Alice Smith',
      })
    ).rejects.toBeInstanceOf(McpError);

    expect(fetchMock.mock.calls.some(([u]) => u.includes('/api/EditUser'))).toBe(false);
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'PATCH')).toHaveLength(0);
  });

  it('passes usageLocation as a bare string', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser('contoso.com', 'alice@contoso.com', { usageLocation: 'US' });

    const [, editInit] = fetchMock.mock.calls.find(([u]) => u.includes('/api/EditUser'))!;
    const body = JSON.parse(editInit.body as string);
    expect(body.usageLocation).toBe('US');
  });

  it('maps licenses to { value } and forces removeLicenses=false when replacing licenses', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser(
      'contoso.com',
      'alice@contoso.com',
      { usageLocation: 'US' },
      { licenses: ['sku-a', 'sku-b'] }
    );

    const [, editInit] = fetchMock.mock.calls.find(([u]) => u.includes('/api/EditUser'))!;
    const body = JSON.parse(editInit.body as string);
    expect(body.licenses).toEqual([{ value: 'sku-a' }, { value: 'sku-b' }]);
    expect(body.removeLicenses).toBe(false);
  });

  it('rejects licenses combined with removeLicenses=true and does not PATCH', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.editUser(
        'contoso.com',
        'alice@contoso.com',
        { usageLocation: 'US' },
        { licenses: ['sku-a'], removeLicenses: true }
      )
    ).rejects.toThrow(/mutually exclusive/i);

    expect(fetchMock.mock.calls.some(([u]) => u.includes('/api/EditUser'))).toBe(false);
  });

  it('sends removeLicenses=true without a licenses key when removing all licenses', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser(
      'contoso.com',
      'alice@contoso.com',
      { usageLocation: 'US' },
      { removeLicenses: true }
    );

    const [, editInit] = fetchMock.mock.calls.find(([u]) => u.includes('/api/EditUser'))!;
    const body = JSON.parse(editInit.body as string);
    expect(body.removeLicenses).toBe(true);
    expect(body.licenses).toBeUndefined();
  });

  it('reports honest failure when CIPP returns HTTP 200 with failed Results', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Failed to edit user. Graph said no'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.editUser('contoso.com', 'alice@contoso.com', {
      displayName: 'Alice Smith',
    })) as { status: string; failures: string[]; message: string };

    expect(result.status).toBe('failed');
    expect(result.failures).toEqual(['Failed to edit user. Graph said no']);
    expect(result.message).toMatch(/Do NOT report success/i);
  });

  it('reports honest success when Results indicate a successful edit', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.editUser('contoso.com', 'alice@contoso.com', {
      displayName: 'Alice Smith',
    })) as { status: string; failures: string[] };

    expect(result.status).toBe('edited');
    expect(result.failures).toEqual([]);
  });

  it('does not send license keys when neither licenses nor removeLicenses is provided', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: '11111111-1111-1111-1111-111111111111', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/EditUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.editUser('contoso.com', 'alice@contoso.com', { displayName: 'Alice Smith' });

    const [, editInit] = fetchMock.mock.calls.find(([u]) => u.includes('/api/EditUser'))!;
    const body = JSON.parse(editInit.body as string);
    expect(body.licenses).toBeUndefined();
    expect(body.removeLicenses).toBeUndefined();
  });

  describe('lookup retry (WYREAI-530)', () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const found = [{ id: userId, userPrincipalName: 'alice@contoso.com' }];

    class FastCippService extends CippService {
      protected override userLookupRetryDelaysMs = [0, 0, 0];
      protected override sleep(): Promise<void> {
        return Promise.resolve();
      }
    }

    let fast: FastCippService;
    beforeEach(() => {
      fast = new FastCippService(
        { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
        logger
      );
    });

    function errorResponse(status: number, text = 'boom'): Response {
      return { ok: false, status, text: async () => text } as unknown as Response;
    }

    const calls = (m: jest.Mock<Promise<Response>, [string, RequestInit]>, name: string) =>
      m.mock.calls.filter(([u]) => u.includes(`/api/${name}`));

    function mockListUsers(listResponses: Array<() => Response>) {
      let i = 0;
      const m = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
        if (url.includes('/api/ListUsers')) {
          const r = listResponses[Math.min(i++, listResponses.length - 1)];
          return Promise.resolve(r());
        }
        if (url.includes('/api/EditUser')) {
          return Promise.resolve(jsonResponse({ Results: ['Success. The user has been edited.'] }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      global.fetch = m as unknown as typeof fetch;
      return m;
    }

    it('retries an empty ListUsers and edits once the user appears', async () => {
      const m = mockListUsers([() => jsonResponse([]), () => jsonResponse(found)]);

      const result = (await fast.editUser('contoso.com', userId, { displayName: 'A' })) as {
        status: string;
      };

      expect(result.status).toBe('edited');
      expect(calls(m, 'ListUsers')).toHaveLength(2);
      expect(calls(m, 'EditUser')).toHaveLength(1);
    });

    it('gives up after exactly 4 ListUsers calls with a Graph-lag hint and no EditUser call', async () => {
      const m = mockListUsers([() => jsonResponse([])]);

      await expect(fast.editUser('contoso.com', userId, { displayName: 'A' })).rejects.toThrow(
        /Could not resolve user[\s\S]*Tried 4 times[\s\S]*Microsoft Graph[\s\S]*retry shortly/
      );

      expect(calls(m, 'ListUsers')).toHaveLength(4);
      expect(calls(m, 'EditUser')).toHaveLength(0);
    });

    it('retries HTTP 404 from ListUsers', async () => {
      const m = mockListUsers([() => errorResponse(404, 'not found'), () => jsonResponse(found)]);

      await fast.editUser('contoso.com', userId, { displayName: 'A' });

      expect(calls(m, 'ListUsers')).toHaveLength(2);
      expect(calls(m, 'EditUser')).toHaveLength(1);
    });

    it('retries a 500 carrying Graph Request_ResourceNotFound for the GUID lookup', async () => {
      const m = mockListUsers([
        () =>
          errorResponse(
            500,
            'Request_ResourceNotFound: Resource \'x\' does not exist or one of its queried reference-property objects are not present.'
          ),
        () => jsonResponse(found),
      ]);

      await fast.editUser('contoso.com', userId, { displayName: 'A' });

      expect(calls(m, 'ListUsers')).toHaveLength(2);
      expect(calls(m, 'EditUser')).toHaveLength(1);
    });

    it.each([400, 401, 403])('does not retry HTTP %i even when the body has the not-found marker', async (status) => {
      const m = mockListUsers([() => errorResponse(status, 'Request_ResourceNotFound: does not exist')]);

      await expect(fast.editUser('contoso.com', userId, { displayName: 'A' })).rejects.toThrow(
        new RegExp(`HTTP ${status}`)
      );

      expect(calls(m, 'ListUsers')).toHaveLength(1);
      expect(calls(m, 'EditUser')).toHaveLength(0);
    });

    it.each([401, 403])('does not retry HTTP %i whose body mentions "returned HTTP 404" and the marker', async (status) => {
      const m = mockListUsers([
        () => errorResponse(status, 'upstream returned HTTP 404: Request_ResourceNotFound'),
      ]);

      await expect(fast.editUser('contoso.com', userId, { displayName: 'A' })).rejects.toThrow(
        new RegExp(`HTTP ${status}`)
      );

      expect(calls(m, 'ListUsers')).toHaveLength(1);
    });

    it('retries a 500 with a JSON Request_ResourceNotFound error body', async () => {
      const m = mockListUsers([
        () =>
          errorResponse(
            500,
            JSON.stringify({ error: { code: 'Request_ResourceNotFound', message: 'gone' } })
          ),
        () => jsonResponse(found),
      ]);

      await fast.editUser('contoso.com', userId, { displayName: 'A' });

      expect(calls(m, 'ListUsers')).toHaveLength(2);
    });

    it('retries a 500 with a plain-text not-found marker', async () => {
      const m = mockListUsers([
        () => errorResponse(500, 'Resource does not exist'),
        () => jsonResponse(found),
      ]);

      await fast.editUser('contoso.com', userId, { displayName: 'A' });

      expect(calls(m, 'ListUsers')).toHaveLength(2);
    });

    it('does not retry a plain 500', async () => {
      const m = mockListUsers([() => errorResponse(500, 'Internal failure')]);

      await expect(fast.editUser('contoso.com', userId, { displayName: 'A' })).rejects.toThrow(
        /HTTP 500/
      );

      expect(calls(m, 'ListUsers')).toHaveLength(1);
    });

    it('reports the last upstream status after exhausting retries on 404', async () => {
      const m = mockListUsers([() => errorResponse(404, 'not found')]);

      const err = (await fast
        .editUser('contoso.com', userId, { displayName: 'A' })
        .catch((e: unknown) => e)) as Error;

      expect(err.message).toMatch(/Tried 4 times/);
      expect(err.message).toContain('Last upstream status: HTTP 404.');
      expect(err.message).not.toContain('not found');
      expect(calls(m, 'ListUsers')).toHaveLength(4);
    });

    it('omits the status suffix when exhaustion came from empty lists', async () => {
      mockListUsers([() => jsonResponse([])]);

      const err = (await fast
        .editUser('contoso.com', userId, { displayName: 'A' })
        .catch((e: unknown) => e)) as Error;

      expect(err.message).not.toContain('Last upstream status');
    });

    it('CippHttpError is an McpError carrying status and body with the unchanged message', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve(errorResponse(418, 'teapot'))
      ) as unknown as typeof fetch;

      const err = await fast.listTenants().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CippHttpError);
      expect(err).toBeInstanceOf(McpError);
      expect((err as CippHttpError).status).toBe(418);
      expect((err as CippHttpError).responseBody).toBe('teapot');
      expect((err as Error).message).toMatch(/CIPP API returned HTTP 418 for GET .*ListTenants.*: teapot$/);
    });

    it.each([400, 401, 403, 500])('does not retry HTTP %i', async (status) => {
      const m = mockListUsers([() => errorResponse(status)]);

      await expect(fast.editUser('contoso.com', userId, { displayName: 'A' })).rejects.toThrow(
        new RegExp(`HTTP ${status}`)
      );

      expect(calls(m, 'ListUsers')).toHaveLength(1);
      expect(calls(m, 'EditUser')).toHaveLength(0);
    });
  });
});
