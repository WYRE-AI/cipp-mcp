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
    expect((error as McpError).message).toMatch(/Retried once with legacy scope/);
    expect((error as McpError).message).toContain(LEGACY_SCOPE);

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

  it('does not retry the legacy scope again once that scope is already active', async () => {
    const fetchMock = installFetch([401, 200, 401]);
    const svc = createService();
    await svc.listTenants();

    const before = fetchMock.mock.calls.length;
    await expect(svc.listTenants()).rejects.toBeInstanceOf(McpError);
    const later = fetchMock.mock.calls.slice(before);
    expect(later.filter(([url]) => String(url).includes('/api/ListTenants'))).toHaveLength(1);
    expect(later.filter(([url]) => String(url).includes('/oauth2/v2.0/token'))).toHaveLength(0);
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
