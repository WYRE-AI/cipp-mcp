// The default OAuth scope used to be `<clientId>/.default`. Entra then sets
// `aud` to the bare client id, and CIPP App Service auth that only allows
// `api://<clientId>` rejects every call with HTTP 401 and an empty body.
// The default is now `api://<clientId>/.default`. When that token is itself
// rejected with 401 and no explicit scope was configured, the same request
// is retried once with the legacy scope and the audience that works is
// remembered for that client.

import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { TokenProvider } from '../src/services/token.service.js';
import { Logger } from '../src/utils/logger.js';
import {
  getCredentialsFromGateway,
  loadEnvironmentConfig,
  mergeWithMcpConfig,
  parseCredentialsFromHeaders,
  parseTokenScopeFallback,
} from '../src/utils/config.js';
import { errorResponse, jsonResponse } from './helpers.js';

const logger = new Logger('error');

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const API_SCOPE = `api://${CLIENT_ID}/.default`;
const LEGACY_SCOPE = `${CLIENT_ID}/.default`;

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit?]>;

function createService(overrides: Record<string, unknown> = {}): CippService {
  return new CippService(
    {
      cipp: {
        baseUrl: 'https://cipp.example',
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        clientSecret: 'secret',
        ...overrides,
      },
    },
    logger
  );
}

function tokenScope(init: RequestInit | undefined): string | null {
  if (typeof init?.body !== 'string') return null;
  return new URLSearchParams(init.body).get('scope');
}

function authorization(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

function callsTo(fetchMock: FetchMock, fragment: string): Array<[string, RequestInit?]> {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));
}

/**
 * Token endpoint returns a bearer derived from the requested scope, so a test
 * can see which audience was minted. CIPP responses come from `apiStatuses`
 * in order; once that list is exhausted every later call succeeds.
 */
function installFetch(apiStatuses: number[]): FetchMock {
  let apiCalls = 0;
  const fetchMock: FetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (String(url).includes('/oauth2/v2.0/token')) {
      const scope = tokenScope(init);
      const accessToken = scope === LEGACY_SCOPE ? 'legacy-token' : `api-token:${scope}`;
      return Promise.resolve(jsonResponse({ access_token: accessToken, expires_in: 3600 }));
    }
    const status = apiStatuses[apiCalls] ?? 200;
    apiCalls += 1;
    if (status !== 200) return Promise.resolve(errorResponse(status, ''));
    return Promise.resolve(jsonResponse([{ customerId: 'contoso' }]));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('OAuth token scope', () => {
  beforeEach(() => {
    TokenProvider.clearPinnedScopes();
  });

  afterEach(() => {
    TokenProvider.clearPinnedScopes();
    jest.restoreAllMocks();
  });

  it('defaults the scope to api://<clientId>/.default', async () => {
    const fetchMock = installFetch([200]);
    await createService().listTenants();

    const tokens = callsTo(fetchMock, '/oauth2/v2.0/token');
    expect(tokens).toHaveLength(1);
    expect(tokenScope(tokens[0][1])).toBe(API_SCOPE);
    expect(tokenScope(tokens[0][1])).not.toBe(LEGACY_SCOPE);

    const api = callsTo(fetchMock, '/api/ListTenants');
    expect(api).toHaveLength(1);
    expect(authorization(api[0][1])).toBe(`Bearer api-token:${API_SCOPE}`);
  });

  it('sends an explicit scope and does not fall back when that token is rejected', async () => {
    const explicit = 'api://custom-sam-app/.default';
    const fetchMock = installFetch([401]);
    const error = await createService({ tokenScope: explicit }).listTenants().then(
      () => {
        throw new Error('expected the 401 to reject');
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/HTTP 401/);
    expect((error as McpError).message).not.toMatch(/Retried once/);

    const tokens = callsTo(fetchMock, '/oauth2/v2.0/token');
    expect(tokens).toHaveLength(1);
    expect(tokenScope(tokens[0][1])).toBe(explicit);
    expect(callsTo(fetchMock, '/api/ListTenants')).toHaveLength(1);
  });

  it('retries a 401 once with the legacy scope and then uses that scope directly', async () => {
    const fetchMock = installFetch([401, 200]);
    const svc = createService();

    await expect(svc.listTenants()).resolves.toEqual([{ customerId: 'contoso' }]);

    const tokens = callsTo(fetchMock, '/oauth2/v2.0/token');
    expect(tokens.map((call) => tokenScope(call[1]))).toEqual([API_SCOPE, LEGACY_SCOPE]);

    const api = callsTo(fetchMock, '/api/ListTenants');
    expect(api).toHaveLength(2);
    expect(authorization(api[0][1])).toBe(`Bearer api-token:${API_SCOPE}`);
    expect(authorization(api[1][1])).toBe('Bearer legacy-token');

    const callsBefore = fetchMock.mock.calls.length;
    await expect(svc.listTenants()).resolves.toEqual([{ customerId: 'contoso' }]);
    const later = fetchMock.mock.calls.slice(callsBefore);
    expect(later).toHaveLength(1);
    expect(String(later[0][0])).toContain('/api/ListTenants');
    expect(authorization(later[0][1])).toBe('Bearer legacy-token');

    // A new provider for the same client mints the legacy scope directly.
    const fresh = createService();
    const beforeFresh = fetchMock.mock.calls.length;
    await expect(fresh.listTenants()).resolves.toEqual([{ customerId: 'contoso' }]);
    const freshCalls = fetchMock.mock.calls.slice(beforeFresh);
    expect(freshCalls).toHaveLength(2);
    expect(String(freshCalls[0][0])).toContain('/oauth2/v2.0/token');
    expect(tokenScope(freshCalls[0][1])).toBe(LEGACY_SCOPE);
    expect(authorization(freshCalls[1][1])).toBe('Bearer legacy-token');

    // A different client does not inherit the pin.
    const other = new CippService(
      {
        cipp: {
          baseUrl: 'https://cipp.example',
          tenantId: TENANT_ID,
          clientId: '33333333-3333-3333-3333-333333333333',
          clientSecret: 'secret',
        },
      },
      logger
    );
    const beforeOther = fetchMock.mock.calls.length;
    await other.listTenants();
    const otherTokens = fetchMock.mock.calls
      .slice(beforeOther)
      .filter(([url]) => String(url).includes('/oauth2/v2.0/token'));
    expect(tokenScope(otherTokens[0][1])).toBe('api://33333333-3333-3333-3333-333333333333/.default');
  });

  it('returns the auth error when the legacy scope is also rejected', async () => {
    const fetchMock = installFetch([401, 401]);

    const error = await createService().listTenants().then(
      () => {
        throw new Error('expected the 401 to reject');
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/HTTP 401/);
    expect((error as McpError).message).toContain(`scope ${LEGACY_SCOPE}`);

    expect(callsTo(fetchMock, '/oauth2/v2.0/token').map((call) => tokenScope(call[1]))).toEqual([
      API_SCOPE,
      LEGACY_SCOPE,
    ]);
    expect(callsTo(fetchMock, '/api/ListTenants')).toHaveLength(2);
  });

  it.each([403, 500])('does not retry a CIPP HTTP %s', async (status) => {
    const fetchMock = installFetch([status]);

    const error = await createService().listTenants().then(
      () => {
        throw new Error(`expected HTTP ${status} to reject`);
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(new RegExp(`HTTP ${status}`));
    expect((error as McpError).message).not.toMatch(/Retried once/);
    expect(callsTo(fetchMock, '/oauth2/v2.0/token')).toHaveLength(1);
    expect(tokenScope(callsTo(fetchMock, '/oauth2/v2.0/token')[0][1])).toBe(API_SCOPE);
    expect(callsTo(fetchMock, '/api/ListTenants')).toHaveLength(1);
  });

  it('does not retry a 401 when the legacy-scope fallback is disabled', async () => {
    const fetchMock = installFetch([401]);

    const error = await createService({ tokenScopeFallback: false }).listTenants().then(
      () => {
        throw new Error('expected the 401 to reject');
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/HTTP 401/);
    expect((error as McpError).message).not.toMatch(/Retried once/);
    expect(callsTo(fetchMock, '/oauth2/v2.0/token')).toHaveLength(1);
    expect(tokenScope(callsTo(fetchMock, '/oauth2/v2.0/token')[0][1])).toBe(API_SCOPE);
    expect(callsTo(fetchMock, '/api/ListTenants')).toHaveLength(1);
  });

  it('does not mint a second token when a static API key is rejected', async () => {
    const fetchMock = installFetch([401]);
    const svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'static-key' } },
      logger
    );

    await expect(svc.listTenants()).rejects.toBeInstanceOf(McpError);
    expect(callsTo(fetchMock, '/oauth2/v2.0/token')).toHaveLength(0);
    expect(callsTo(fetchMock, '/api/ListTenants')).toHaveLength(1);
  });

  it('flips a pinned legacy scope back to api:// after a 401', async () => {
    const fetchMock = installFetch([401, 200, 401, 200]);
    const svc = createService();
    await svc.listTenants();

    const beforeFlip = fetchMock.mock.calls.length;
    await expect(svc.listTenants()).resolves.toEqual([{ customerId: 'contoso' }]);
    const flip = fetchMock.mock.calls.slice(beforeFlip);
    const flipApi = flip.filter(([url]) => String(url).includes('/api/ListTenants'));
    const flipTokens = flip.filter(([url]) => String(url).includes('/oauth2/v2.0/token'));
    expect(flipApi).toHaveLength(2);
    expect(authorization(flipApi[0][1])).toBe('Bearer legacy-token');
    expect(authorization(flipApi[1][1])).toBe(`Bearer api-token:${API_SCOPE}`);
    expect(flipTokens).toHaveLength(1);
    expect(tokenScope(flipTokens[0][1])).toBe(API_SCOPE);

    const beforeLater = fetchMock.mock.calls.length;
    await expect(svc.listTenants()).resolves.toEqual([{ customerId: 'contoso' }]);
    const later = fetchMock.mock.calls.slice(beforeLater);
    expect(later).toHaveLength(1);
    expect(authorization(later[0][1])).toBe(`Bearer api-token:${API_SCOPE}`);

    const fresh = createService();
    const beforeFresh = fetchMock.mock.calls.length;
    await fresh.listTenants();
    const freshTokens = fetchMock.mock.calls
      .slice(beforeFresh)
      .filter(([url]) => String(url).includes('/oauth2/v2.0/token'));
    expect(tokenScope(freshTokens[0][1])).toBe(API_SCOPE);
  });

  it('flips a pinned api:// scope to the legacy scope after a 401', async () => {
    const fetchMock = installFetch([200, 401, 200]);
    const svc = createService();
    await svc.listTenants();

    const beforeFlip = fetchMock.mock.calls.length;
    await expect(svc.listTenants()).resolves.toEqual([{ customerId: 'contoso' }]);
    const flip = fetchMock.mock.calls.slice(beforeFlip);
    const flipApi = flip.filter(([url]) => String(url).includes('/api/ListTenants'));
    const flipTokens = flip.filter(([url]) => String(url).includes('/oauth2/v2.0/token'));
    expect(flipApi).toHaveLength(2);
    expect(authorization(flipApi[0][1])).toBe(`Bearer api-token:${API_SCOPE}`);
    expect(authorization(flipApi[1][1])).toBe('Bearer legacy-token');
    expect(flipTokens).toHaveLength(1);
    expect(tokenScope(flipTokens[0][1])).toBe(LEGACY_SCOPE);

    const fresh = createService();
    const beforeFresh = fetchMock.mock.calls.length;
    await fresh.listTenants();
    const freshCalls = fetchMock.mock.calls.slice(beforeFresh);
    expect(freshCalls.filter(([url]) => String(url).includes('/api/ListTenants'))).toHaveLength(1);
    expect(tokenScope(freshCalls.find(([url]) => String(url).includes('/oauth2/v2.0/token'))?.[1])).toBe(
      LEGACY_SCOPE
    );
    expect(authorization(freshCalls.find(([url]) => String(url).includes('/api/ListTenants'))?.[1])).toBe(
      'Bearer legacy-token'
    );
  });

  it('does not try a third audience when the alternate scope is also rejected', async () => {
    const fetchMock = installFetch([401, 200, 401, 401]);
    const svc = createService();
    await svc.listTenants();

    const before = fetchMock.mock.calls.length;
    const error = await svc.listTenants().then(
      () => {
        throw new Error('expected the 401 to reject');
      },
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/HTTP 401/);
    expect((error as McpError).message).toContain(API_SCOPE);

    const later = fetchMock.mock.calls.slice(before);
    const api = later.filter(([url]) => String(url).includes('/api/ListTenants'));
    const tokens = later.filter(([url]) => String(url).includes('/oauth2/v2.0/token'));
    expect(api).toHaveLength(2);
    expect(authorization(api[0][1])).toBe('Bearer legacy-token');
    expect(authorization(api[1][1])).toBe(`Bearer api-token:${API_SCOPE}`);
    expect(tokens).toHaveLength(1);
    expect(tokenScope(tokens[0][1])).toBe(API_SCOPE);

    // The same ceiling holds when the pin started on api://.
    TokenProvider.clearPinnedScopes();
    const apiPinned = installFetch([200, 401, 401]);
    const pinnedApi = createService();
    await pinnedApi.listTenants();
    const beforeApi = apiPinned.mock.calls.length;
    await expect(pinnedApi.listTenants()).rejects.toBeInstanceOf(McpError);
    const apiLater = apiPinned.mock.calls.slice(beforeApi);
    const apiCalls = apiLater.filter(([url]) => String(url).includes('/api/ListTenants'));
    const apiTokens = apiLater.filter(([url]) => String(url).includes('/oauth2/v2.0/token'));
    expect(apiCalls).toHaveLength(2);
    expect(authorization(apiCalls[0][1])).toBe(`Bearer api-token:${API_SCOPE}`);
    expect(authorization(apiCalls[1][1])).toBe('Bearer legacy-token');
    expect(apiTokens).toHaveLength(1);
    expect(tokenScope(apiTokens[0][1])).toBe(LEGACY_SCOPE);
  });

  it('retries the other audience when a concurrent request pins legacy during the 401', async () => {
    interface HeldCall {
      auth: string | undefined;
      resolve: (response: Response) => void;
    }
    const cippCalls: HeldCall[] = [];

    global.fetch = jest.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('/oauth2/v2.0/token')) {
        const scope = tokenScope(init);
        const accessToken = scope === LEGACY_SCOPE ? 'legacy-token' : `api-token:${scope}`;
        return Promise.resolve(jsonResponse({ access_token: accessToken, expires_in: 3600 }));
      }
      return new Promise<Response>((resolve) => {
        cippCalls.push({ auth: authorization(init), resolve });
      });
    }) as unknown as typeof fetch;

    const pendingA = createService().listTenants();
    const pendingB = createService().listTenants();
    const waitForCalls = async (count: number): Promise<void> => {
      for (let i = 0; i < 20 && cippCalls.length < count; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (cippCalls.length < count) {
        throw new Error(`expected ${count} CIPP calls, saw ${cippCalls.length}`);
      }
    };

    try {
      await waitForCalls(2);
      // Both in-flight calls still carry the api:// token.
      expect(cippCalls[0].auth).toBe(`Bearer api-token:${API_SCOPE}`);
      expect(cippCalls[1].auth).toBe(`Bearer api-token:${API_SCOPE}`);

      // A's api:// token is rejected. Its retry succeeds and pins legacy
      // while B is still waiting on the same audience.
      cippCalls[0].resolve(errorResponse(401, ''));
      await waitForCalls(3);
      expect(cippCalls[2].auth).toBe('Bearer legacy-token');
      cippCalls[2].resolve(jsonResponse([{ customerId: 'contoso' }]));
      await expect(pendingA).resolves.toEqual([{ customerId: 'contoso' }]);

      // B's original api:// call is rejected only after that pin exists.
      // The retry must use legacy, not the api:// audience that just failed.
      cippCalls[1].resolve(errorResponse(401, ''));
      await waitForCalls(4);
      expect(cippCalls[3].auth).toBe('Bearer legacy-token');
      expect(cippCalls).toHaveLength(4);

      cippCalls[3].resolve(jsonResponse([{ customerId: 'contoso' }]));
      await expect(pendingB).resolves.toEqual([{ customerId: 'contoso' }]);
    } finally {
      for (const call of cippCalls) {
        call.resolve(errorResponse(401, ''));
      }
      await Promise.allSettled([pendingA, pendingB]);
    }
  });
});

describe('token scope fallback configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith('CIPP_') ||
        key.startsWith('X_') ||
        key === 'TOKEN_SCOPE_FALLBACK'
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults the fallback to enabled', () => {
    expect(loadEnvironmentConfig().cipp.tokenScopeFallback).toBe(true);
    expect(parseTokenScopeFallback(undefined)).toBeUndefined();
    expect(parseCredentialsFromHeaders({}).tokenScopeFallback).toBeUndefined();
  });

  it('honours CIPP_TOKEN_SCOPE_FALLBACK and the TOKEN_SCOPE_FALLBACK alias', () => {
    process.env.CIPP_TOKEN_SCOPE_FALLBACK = 'false';
    expect(loadEnvironmentConfig().cipp.tokenScopeFallback).toBe(false);

    delete process.env.CIPP_TOKEN_SCOPE_FALLBACK;
    process.env.TOKEN_SCOPE_FALLBACK = 'off';
    expect(loadEnvironmentConfig().cipp.tokenScopeFallback).toBe(false);

    process.env.CIPP_TOKEN_SCOPE_FALLBACK = 'false';
    process.env.TOKEN_SCOPE_FALLBACK = 'true';
    expect(loadEnvironmentConfig().cipp.tokenScopeFallback).toBe(false);
  });

  it('lets an MCP argument of false override an enabled env default', () => {
    const merged = mergeWithMcpConfig(loadEnvironmentConfig(), {
      cipp: { tokenScopeFallback: false },
    });
    expect(merged.cipp.tokenScopeFallback).toBe(false);
  });

  it('reads X_TOKEN_SCOPE_FALLBACK from the gateway environment', () => {
    process.env.AUTH_MODE = 'gateway';
    process.env.X_TOKEN_SCOPE_FALLBACK = 'no';

    expect(getCredentialsFromGateway().tokenScopeFallback).toBe(false);
    expect(loadEnvironmentConfig().cipp.tokenScopeFallback).toBe(false);
  });

  it('reads x-token-scope-fallback and treats an explicit false as off', () => {
    expect(
      parseCredentialsFromHeaders({ 'x-token-scope-fallback': 'false' }).tokenScopeFallback
    ).toBe(false);
    expect(
      parseCredentialsFromHeaders({ 'x-token-scope-fallback': 'NO' }).tokenScopeFallback
    ).toBe(false);
    expect(
      parseCredentialsFromHeaders({ 'x-token-scope-fallback': 'true' }).tokenScopeFallback
    ).toBe(true);
    // A header that says off beats a process default of on. `??` keeps false.
    const fromHeader = parseCredentialsFromHeaders({ 'x-token-scope-fallback': '0' });
    expect(fromHeader.tokenScopeFallback ?? true).toBe(false);
  });
});
