// HTTP transport fail-closed auth.
//
// Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
// Known placeholders are rejected even with that flag. The flag binds
// 127.0.0.1 only. /mcp rejects a missing or invalid X-Gateway-S2S header.
// AUTH_MODE=gateway rejects requests that omit CIPP credential headers and
// must not fall back to CIPP_* in process.env.

import { createHmac } from 'node:crypto';
import { CippMcpServer } from '../src/mcp/server.js';
import { Logger } from '../src/utils/logger.js';
import { loadEnvironmentConfig, mergeWithMcpConfig } from '../src/utils/config.js';

const S2S_SECRET = 's2s-do-not-log-7f3a9c';
const ENV_BASE_URL = 'https://env-must-not-be-used.example';
const ENV_API_KEY = 'env-api-key-must-not-be-used';
const HEADER_BASE_URL = 'https://header-cipp.example';
const HEADER_API_KEY = 'header-api-key-from-request';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'MCP_TRANSPORT',
  'CIPP_BASE_URL',
  'CIPP_API_KEY',
  'CIPP_TENANT_ID',
  'CIPP_CLIENT_ID',
  'CIPP_CLIENT_SECRET',
  'LOG_LEVEL',
  'LOG_FORMAT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: CippMcpServer[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  // Winston writes error logs via console._stderr. Under Jest that stream is
  // not process.stderr, and jest.spyOn does not intercept the native write.
  const stderr = (console as unknown as { _stderr?: NodeJS.WriteStream })._stderr ?? process.stderr;
  const original = stderr.write;
  stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof stderr.write;
  return {
    text: () => lines.join(''),
    restore: () => {
      stderr.write = original;
    },
  };
}

function mockExit(): jest.SpiedFunction<typeof process.exit> {
  return jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface Started {
  server: CippMcpServer;
  port: number;
  address: string;
}

async function startServer(): Promise<Started> {
  const envConfig = loadEnvironmentConfig();
  const server = new CippMcpServer(mergeWithMcpConfig(envConfig), new Logger('error', 'simple'), envConfig);
  servers.push(server);
  await server.start();
  const bound = server.httpAddress();
  if (!bound) throw new Error('HTTP server did not bind a TCP port');
  return { server, port: bound.port, address: bound.address };
}

async function closeAll(): Promise<void> {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await server.stop();
  }
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const listTools = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
});

const pingCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'cipp_ping', arguments: {} },
});

interface OutboundCall {
  url: string;
  authorization?: string;
}

function installFetchSpy(port: number): { calls: OutboundCall[]; restore: () => void } {
  const calls: OutboundCall[] = [];
  const realFetch = global.fetch;
  global.fetch = jest.fn((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(`http://127.0.0.1:${port}`)) {
      return realFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization') ?? undefined;
    calls.push(authorization === undefined ? { url } : { url, authorization });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  return {
    calls,
    restore: () => {
      global.fetch = realFetch;
    },
  };
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'error';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.CIPP_BASE_URL;
  delete process.env.CIPP_API_KEY;
  delete process.env.CIPP_TENANT_ID;
  delete process.env.CIPP_CLIENT_ID;
  delete process.env.CIPP_CLIENT_SECRET;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeAll();
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exit = mockExit();
    try {
      await expect(startServer()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    const logs = captureStderr();
    const exit = mockExit();
    try {
      await expect(startServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      expect(logs.text()).toContain('CONDUIT_S2S_SECRET is empty');
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it.each([
    'changeme',
    'CHANGE-ME',
    'your-s2s-secret',
    'replace-with-a-real-secret',
    '${user_config.conduit_s2s_secret}',
  ])('refuses a known placeholder secret (%s) even when the dev bypass is set', async (placeholder) => {
    process.env.CONDUIT_S2S_SECRET = placeholder;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    const logs = captureStderr();
    const exit = mockExit();
    try {
      await expect(startServer()).rejects.toThrow('process.exit:1');
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('known placeholder');
      expect(text).not.toContain(placeholder.trim());
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it('refuses the placeholder word "secret" without echoing the raw value', async () => {
    process.env.CONDUIT_S2S_SECRET = '  secret  ';
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    const logs = captureStderr();
    const exit = mockExit();
    try {
      await expect(startServer()).rejects.toThrow('process.exit:1');
      const text = logs.text();
      expect(text).toContain('known placeholder');
      expect(text).not.toContain('  secret  ');
    } finally {
      exit.mockRestore();
      logs.restore();
    }
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const started = await startServer();
      expect(started.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('not a loopback address');
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      try {
        const started = await startServer();
        expect(started.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain('SECURITY WARNING');
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        logs.restore();
      }
    }
  );

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();
    try {
      const started = await startServer();
      expect(started.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it('binds 127.0.0.1 when a secret is set and MCP_HTTP_HOST is unset', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    const started = await startServer();
    expect(started.address).toBe('127.0.0.1');
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.CIPP_BASE_URL = ENV_BASE_URL;
    process.env.CIPP_API_KEY = ENV_API_KEY;
  });

  it('returns 401 when the S2S header is missing or invalid and does not call CIPP', async () => {
    const logs = captureStderr();
    const started = await startServer();
    const fetchSpy = installFetchSpy(started.port);
    try {
      const missing = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-base-url': HEADER_BASE_URL,
          'x-api-key': HEADER_API_KEY,
        }),
        body: pingCall,
      });
      const invalid = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
          'x-base-url': HEADER_BASE_URL,
          'x-api-key': HEADER_API_KEY,
        }),
        body: pingCall,
      });
      const missingBody = await missing.text();
      const invalidBody = await invalid.text();

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missingBody).toContain('X-Gateway-S2S');
      expect(invalidBody).toContain('X-Gateway-S2S');
      for (const body of [missingBody, invalidBody]) {
        expect(body).not.toContain(S2S_SECRET);
        expect(body).not.toContain(ENV_API_KEY);
        expect(body).not.toContain(HEADER_API_KEY);
        expect(body).not.toContain(ENV_BASE_URL);
      }
      expect(fetchSpy.calls).toEqual([]);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_API_KEY);
      expect(logs.text()).not.toContain(HEADER_API_KEY);
    } finally {
      fetchSpy.restore();
      logs.restore();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const started = await startServer();
    const fetchSpy = installFetchSpy(started.port);
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
        body: pingCall,
      });
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).toContain('Missing credentials');
      expect(body).toContain('x-base-url');
      expect(body).toContain('x-api-key');
      expect(body).not.toContain(ENV_API_KEY);
      expect(body).not.toContain(ENV_BASE_URL);
      expect(body).not.toContain(S2S_SECRET);
      expect(fetchSpy.calls).toEqual([]);

      const partial = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-base-url': HEADER_BASE_URL,
        }),
        body: listTools,
      });
      expect(partial.status).toBe(401);
      expect(fetchSpy.calls).toEqual([]);
    } finally {
      fetchSpy.restore();
    }
  });

  it('accepts a valid S2S header plus credential headers and uses those credentials', async () => {
    const logs = captureStderr();
    const started = await startServer();
    const fetchSpy = installFetchSpy(started.port);
    try {
      const listed = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-base-url': HEADER_BASE_URL,
          'x-api-key': HEADER_API_KEY,
        }),
        body: listTools,
      });
      expect(listed.status).toBe(200);
      const listedBody = await listed.json() as { result?: { tools?: unknown[] } };
      expect(listedBody.result?.tools?.length).toBeGreaterThan(0);

      const ping = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-base-url': HEADER_BASE_URL,
          'x-api-key': HEADER_API_KEY,
        }),
        body: pingCall,
      });
      const pingBody = await ping.text();

      expect(ping.status).toBe(200);
      expect(pingBody).not.toContain(S2S_SECRET);
      expect(pingBody).not.toContain(ENV_API_KEY);
      expect(pingBody).not.toContain(ENV_BASE_URL);
      expect(fetchSpy.calls).toEqual([
        {
          url: `${HEADER_BASE_URL}/api/PublicPing`,
          authorization: `Bearer ${HEADER_API_KEY}`,
        },
      ]);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(logs.text()).not.toContain(ENV_API_KEY);
      expect(logs.text()).not.toContain(HEADER_API_KEY);
    } finally {
      fetchSpy.restore();
      logs.restore();
    }
  });

  it('serves /health without authentication and without reading credentials', async () => {
    const started = await startServer();
    const fetchSpy = installFetchSpy(started.port);
    try {
      const response = await fetch(`http://127.0.0.1:${started.port}/health`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(body)).toEqual({ status: 'ok' });
      expect(body).not.toContain(S2S_SECRET);
      expect(body).not.toContain(ENV_API_KEY);
      expect(body).not.toContain(ENV_BASE_URL);
      expect(fetchSpy.calls).toEqual([]);
    } finally {
      fetchSpy.restore();
    }
  });
});

describe('HTTP dev bypass still requires gateway credentials', () => {
  it('does not enforce X-Gateway-S2S and still rejects missing credential headers', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.CONDUIT_S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    process.env.AUTH_MODE = 'gateway';
    process.env.CIPP_BASE_URL = ENV_BASE_URL;
    process.env.CIPP_API_KEY = ENV_API_KEY;

    const logs = captureStderr();
    const started = await startServer();
    const fetchSpy = installFetchSpy(started.port);
    try {
      expect(started.address).toBe('127.0.0.1');
      const missingCreds = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders(),
        body: listTools,
      });
      const missingBody = await missingCreds.text();
      expect(missingCreds.status).toBe(401);
      expect(missingBody).toContain('Missing credentials');
      expect(missingBody).not.toContain(ENV_API_KEY);

      const allowed = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
        method: 'POST',
        headers: mcpHeaders({
          'x-base-url': HEADER_BASE_URL,
          'x-api-key': HEADER_API_KEY,
        }),
        body: listTools,
      });
      expect(allowed.status).toBe(200);
      expect(fetchSpy.calls).toEqual([]);
      expect(logs.text()).toContain('SECURITY WARNING');
      expect(logs.text()).not.toContain(ENV_API_KEY);
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      fetchSpy.restore();
      logs.restore();
    }
  });
});
