// Regression tests for the itglue-mcp #73 "unresolved MCPB config placeholder"
// pattern applied to cipp-mcp.
//
// MCPB/DXT desktop bundles map env vars to `${user_config.X}` in manifest.json.
// When an OPTIONAL user_config field is left blank, Claude Desktop injects the
// LITERAL string `${user_config.X}` into the env var — not empty, not omitted.
//
// CIPP supports two auth modes: a static Bearer API key OR OAuth
// client-credentials. A user who configures OAuth and leaves the optional API
// key blank ends up with `CIPP_API_KEY="${user_config.cipp_api_key}"`. Because
// that literal is truthy, CippService's `if (!apiKey && tenantId && clientId &&
// clientSecret)` guard never builds the OAuth TokenProvider and instead sends
// `Authorization: Bearer ${user_config.cipp_api_key}` — a guaranteed 401 on
// every request. Sanitising credentials at ingress fixes it.

import {
  cleanCredential,
  sanitizeCredentials,
  getCredentialsFromGateway,
  parseCredentialsFromHeaders,
  loadEnvironmentConfig,
  mergeWithMcpConfig,
} from '../src/utils/config.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

const logger = new Logger('error');
const API_KEY_PLACEHOLDER = '${user_config.cipp_api_key}';

describe('cleanCredential', () => {
  it('drops undefined, empty, and whitespace-only values', () => {
    expect(cleanCredential(undefined)).toBeUndefined();
    expect(cleanCredential('')).toBeUndefined();
    expect(cleanCredential('   ')).toBeUndefined();
  });

  it('drops unresolved ${user_config.X} manifest placeholders', () => {
    expect(cleanCredential(API_KEY_PLACEHOLDER)).toBeUndefined();
    expect(cleanCredential('  ${user_config.cipp_api_key}  ')).toBeUndefined();
    expect(cleanCredential('${user_config.cipp_client_secret}')).toBeUndefined();
  });

  it('preserves and trims real credentials', () => {
    expect(cleanCredential('real-api-key')).toBe('real-api-key');
    expect(cleanCredential('  real-api-key  ')).toBe('real-api-key');
  });
});

describe('sanitizeCredentials', () => {
  it('strips placeholder fields while keeping real ones', () => {
    const cleaned = sanitizeCredentials({
      apiKey: API_KEY_PLACEHOLDER,
      baseUrl: 'https://cipp.example',
      tenantId: 'tenant-123',
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      tokenScope: undefined,
      tokenUrl: '   ',
    });

    expect(cleaned.apiKey).toBeUndefined();
    expect(cleaned.tokenUrl).toBeUndefined();
    expect(cleaned.baseUrl).toBe('https://cipp.example');
    expect(cleaned.tenantId).toBe('tenant-123');
    expect(cleaned.clientId).toBe('client-abc');
    expect(cleaned.clientSecret).toBe('secret-xyz');
  });
});

describe('issue #73: unresolved MCPB placeholders at credential ingress', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Ensure a clean slate for CIPP_* / X_* between cases.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CIPP_') || key.startsWith('X_')) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('loadEnvironmentConfig ignores a placeholder API key but keeps OAuth creds', () => {
    process.env.CIPP_BASE_URL = 'https://cipp.example';
    process.env.CIPP_API_KEY = API_KEY_PLACEHOLDER; // optional field left blank
    process.env.CIPP_TENANT_ID = 'tenant-123';
    process.env.CIPP_CLIENT_ID = 'client-abc';
    process.env.CIPP_CLIENT_SECRET = 'secret-xyz';

    const { cipp } = loadEnvironmentConfig();

    // The placeholder must NOT survive as a real Bearer token...
    expect(cipp.apiKey).toBeUndefined();
    // ...and the OAuth fields must remain so the token provider can be built.
    expect(cipp.tenantId).toBe('tenant-123');
    expect(cipp.clientId).toBe('client-abc');
    expect(cipp.clientSecret).toBe('secret-xyz');
  });

  it('getCredentialsFromGateway (env/header promotion) drops a placeholder API key', () => {
    process.env.X_API_KEY = API_KEY_PLACEHOLDER;
    process.env.X_TENANT_ID = 'tenant-123';
    process.env.X_CLIENT_ID = 'client-abc';
    process.env.X_CLIENT_SECRET = 'secret-xyz';

    const creds = getCredentialsFromGateway();

    expect(creds.apiKey).toBeUndefined();
    expect(creds.tenantId).toBe('tenant-123');
    expect(creds.clientId).toBe('client-abc');
    expect(creds.clientSecret).toBe('secret-xyz');
  });

  it('parseCredentialsFromHeaders drops a placeholder API key', () => {
    const creds = parseCredentialsFromHeaders({
      'x-api-key': API_KEY_PLACEHOLDER,
      'x-tenant-id': 'tenant-123',
      'x-client-id': 'client-abc',
      'x-client-secret': 'secret-xyz',
    });

    expect(creds.apiKey).toBeUndefined();
    expect(creds.tenantId).toBe('tenant-123');
  });

  it('the 401 repro: OAuth path is taken, never a Bearer placeholder', async () => {
    process.env.CIPP_BASE_URL = 'https://cipp.example';
    process.env.CIPP_API_KEY = API_KEY_PLACEHOLDER; // blank optional field
    process.env.CIPP_TENANT_ID = 'tenant-123';
    process.env.CIPP_CLIENT_ID = 'client-abc';
    process.env.CIPP_CLIENT_SECRET = 'secret-xyz';

    const config = mergeWithMcpConfig(loadEnvironmentConfig());
    const svc = new CippService(config, logger);

    // First fetch = Entra token endpoint; second = the CIPP API request.
    const fetchMock = jest.fn((url: string, _init?: RequestInit) => {
      if (url.includes('/oauth2/v2.0/token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ access_token: 'minted-oauth-token', expires_in: 3600 }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ customerId: 'contoso' }]),
      } as unknown as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.listTenants();

    // A token exchange must have happened — proving the OAuth path engaged
    // instead of short-circuiting on the truthy placeholder.
    const tokenCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/oauth2/v2.0/token')
    );
    expect(tokenCall).toBeDefined();

    const apiCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/')
    );
    expect(apiCall).toBeDefined();
    const authHeader = (apiCall![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(authHeader.Authorization).toBe('Bearer minted-oauth-token');
    expect(authHeader.Authorization).not.toContain('user_config');
  });
});
