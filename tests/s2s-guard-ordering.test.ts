// S2S guard ordering vs. lazy CIPP OAuth exchange
//
// src/mcp/server.ts enforces the Conduit gateway's service-to-service auth
// (`X-Gateway-S2S`) as a hard early-return on every POST /mcp, BEFORE any
// credential extraction or tool dispatch runs (see the
// `if (S2S_SECRET && !verifyS2sHeader(...))` block). That half is easy to
// get backwards by accident (e.g. moving the guard below credential
// parsing), so this test proves the ordering at the HTTP boundary rather
// than by reading the source.
//
// The trap: CIPP's own OAuth exchange is LAZY. TokenProvider.fetchToken()
// (src/services/token.service.ts) is only invoked from
// TokenProvider.getAccessToken(), which CippService#request() calls on the
// first actual CIPP API call inside a tool handler (src/services/cipp.service.ts:270)
// — never eagerly in the HTTP request handler. A guard that "worked" by
// accident (e.g. only blocked because credentials were also missing) could
// look correct while actually sitting in the wrong place. Asserting zero
// calls to getAccessToken() on a rejected request is therefore only
// meaningful if the same probe can also observe a nonzero call count when
// the guard *should* let a request through — that positive case is the
// negative control in the last test below.
//
// Negative control scope note (approach (a) from the task): rather than
// stubbing out the lazy trigger, this test drives one real MCP
// `tools/call` (`cipp_ping`) through the actual HTTP transport with a
// valid S2S header plus valid-shaped gateway OAuth credentials, and lets
// the real TokenProvider.getAccessToken() -> fetchToken() code path run.
// Only the network boundary (global fetch) is stubbed, and only for
// requests that are NOT aimed at this test's own loopback server — so the
// guard, the credential parsing, the tool dispatch, and the real
// getAccessToken()/fetchToken() logic are all exercised for real. This is
// the strongest form available without a live Entra tenant.

import { createHmac } from 'node:crypto';
import type { CippMcpServer as CippMcpServerType } from '../src/mcp/server.js';
import type { TokenProvider as TokenProviderType } from '../src/services/token.service.js';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 47531;
const TEST_S2S_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';
const WRONG_S2S_SECRET = 'wrong-secret-must-not-verify';

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

/** Valid-shaped (but fake) gateway OAuth credential headers for CIPP. */
const GATEWAY_OAUTH_HEADERS = {
  'x-base-url': 'https://cipp.invalid.test',
  'x-tenant-id': '00000000-0000-0000-0000-000000000001',
  'x-client-id': '00000000-0000-0000-0000-000000000002',
  'x-client-secret': 'fake-client-secret-for-test',
};

async function postToMcp(headers: Record<string, string>, body: Record<string, unknown>) {
  return fetch(`http://${TEST_HOST}:${TEST_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${TEST_HOST}:${TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('test HTTP server did not become ready in time');
}

describe('S2S guard ordering vs. lazy CIPP OAuth exchange', () => {
  let CippMcpServer: typeof CippMcpServerType;
  let TokenProvider: typeof TokenProviderType;
  let mcpServer: InstanceType<typeof CippMcpServerType>;
  let getAccessTokenSpy: jest.SpiedFunction<TokenProviderType['getAccessToken']>;
  let realFetch: typeof fetch;

  beforeAll(async () => {
    // server.ts reads CONDUIT_S2S_SECRET into a module-level const at
    // import time (`const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || ''`),
    // so the env var must be set BEFORE the module is first required, and
    // modules must be reset in case an earlier test file already cached an
    // unconfigured copy.
    process.env.CONDUIT_S2S_SECRET = TEST_S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_TRANSPORT = 'http';
    process.env.MCP_HTTP_PORT = String(TEST_PORT);
    process.env.MCP_HTTP_HOST = TEST_HOST;

    jest.resetModules();

    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ TokenProvider } = require('../src/services/token.service.js'));
    ({ CippMcpServer } = require('../src/mcp/server.js'));
    const { loadEnvironmentConfig, mergeWithMcpConfig } = require('../src/utils/config.js');
    const { Logger } = require('../src/utils/logger.js');
    /* eslint-enable @typescript-eslint/no-require-imports */

    // The instrumented probe: every real CippService instance the server
    // constructs per-request builds its own TokenProvider, so spying on the
    // prototype (rather than an instance) catches all of them.
    getAccessTokenSpy = jest.spyOn(TokenProvider.prototype, 'getAccessToken');

    const envConfig = loadEnvironmentConfig();
    const mcpConfig = mergeWithMcpConfig(envConfig);
    const logger = new Logger('error', 'simple');

    mcpServer = new CippMcpServer(mcpConfig, logger, envConfig);
    await mcpServer.start();
    await waitForServerReady();
    // Generous timeout: this hook does a real build's worth of module
    // loading plus binding a real TCP listener, which is slow when the
    // whole suite runs in parallel under CI load (the default 5s hook
    // timeout was observed to flake under `npm test`, though it was fine
    // running this file alone).
  }, 20000);

  afterAll(async () => {
    await mcpServer.stop();
    delete process.env.CONDUIT_S2S_SECRET;
    delete process.env.AUTH_MODE;
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_HTTP_HOST;
  }, 10000);

  beforeEach(() => {
    getAccessTokenSpy.mockClear();

    // Stub only the network boundary. Calls aimed at this test's own
    // loopback server pass through to the real fetch (that's how the test
    // talks to the server under test); anything else — the Entra token
    // endpoint TokenProvider.fetchToken() calls, or the follow-up CIPP API
    // call CippService#request() makes with the resulting bearer token — is
    // answered with a canned success response so the test never touches a
    // real network.
    realFetch = global.fetch;
    global.fetch = jest.fn(((input: string, init?: RequestInit) => {
      if (input.startsWith(`http://${TEST_HOST}:${TEST_PORT}`)) {
        return realFetch(input, init);
      }
      const payload = { access_token: 'fake-access-token-for-test', expires_in: 3600 };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
      } as unknown as Response);
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('rejects a request with a missing S2S header with 401, before any CIPP OAuth exchange', async () => {
    const res = await postToMcp(
      { ...GATEWAY_OAUTH_HEADERS },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'cipp_ping', arguments: {} }, id: 1 }
    );

    expect(res.status).toBe(401);
    expect(getAccessTokenSpy).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid S2S header with 401, before any CIPP OAuth exchange', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await postToMcp(
      {
        ...GATEWAY_OAUTH_HEADERS,
        'x-gateway-s2s': mintS2sHeader(WRONG_S2S_SECRET, now),
      },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'cipp_ping', arguments: {} }, id: 2 }
    );

    expect(res.status).toBe(401);
    expect(getAccessTokenSpy).not.toHaveBeenCalled();
  });

  // Negative control: proves the probe above isn't vacuously green. Same
  // spy, same server, only the S2S header changes from invalid to valid —
  // if the spy were broken (e.g. spying on the wrong class, or a stale
  // module reference), this test would fail to see a call and catch it.
  it('control: a request with a VALID S2S header reaches the real tool handler and DOES call TokenProvider.getAccessToken', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await postToMcp(
      {
        ...GATEWAY_OAUTH_HEADERS,
        'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, now),
      },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'cipp_ping', arguments: {} }, id: 3 }
    );

    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { result?: { isError?: boolean } };
    // cipp_ping's single CIPP call is answered by the canned fetch stub
    // above, so the tool call itself should succeed end-to-end.
    expect(parsed.result?.isError).not.toBe(true);
    expect(getAccessTokenSpy).toHaveBeenCalledTimes(1);
  });
});
