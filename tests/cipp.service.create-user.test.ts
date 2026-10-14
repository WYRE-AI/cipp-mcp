import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';

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

/**
 * CIPP's Invoke-AddUser rebuilds the UPN from `username` + `Domain`
 * (New-CippUser.ps1) and ignores `userPrincipalName`. Forwarding a full UPN
 * produced `@` or `user@domain@domain` upstream, surfacing as a misleading
 * "The domain portion of the userPrincipalName property is invalid" 500.
 */
describe('CippService createUser', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // createUser now returns a VerifiedWrite envelope (readback against
  // ListUsers) instead of the raw AddUser response -- see
  // tests/cipp.service.verified-writes.test.ts for the confirmed/pending/
  // failed envelope coverage. These two tests keep their own distinct value
  // (multi-@ local parts, which that suite doesn't exercise) by mocking the
  // readback too, rather than being superseded by it.
  it('splits userPrincipalName into username + Domain and drops the UPN field', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/AddUser')) {
        return Promise.resolve(jsonResponse({ Results: ['Success. The user has been created.'] }));
      }
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: 'obj-1', userPrincipalName: 'alice@contoso.com' }])
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.createUser('contoso.com', {
      displayName: 'Alice Smith',
      userPrincipalName: 'alice@contoso.com',
      password: 'P@ssw0rd!',
    });

    const [, init] = fetchMock.mock.calls.find(([u]) => u.includes('/api/AddUser'))!;
    const body = JSON.parse(init.body as string);
    expect(body.username).toBe('alice');
    expect(body.Domain).toBe('contoso.com');
    expect(body.userPrincipalName).toBeUndefined();
    expect(body.displayName).toBe('Alice Smith');
    expect(body.tenantFilter).toBe('contoso.com');
  });

  it('splits on the LAST @ so local parts containing @ do not corrupt the domain', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: 'obj-1', userPrincipalName: 'weird@name@contoso.com' }])
        );
      }
      return Promise.resolve(jsonResponse({ Results: ['ok'] }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.createUser('contoso.com', {
      displayName: 'Odd Name',
      userPrincipalName: 'weird@name@contoso.com',
      password: 'P@ssw0rd!',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.username).toBe('weird@name');
    expect(body.Domain).toBe('contoso.com');
  });

  it('rejects a bare username with no domain rather than sending "user@" upstream', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: ['ok'] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.createUser('contoso.com', {
        displayName: 'Alice Smith',
        userPrincipalName: 'alice',
        password: 'P@ssw0rd!',
      })
    ).rejects.toBeInstanceOf(McpError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a UPN with an empty domain half', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: ['ok'] }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.createUser('contoso.com', {
        displayName: 'Alice Smith',
        userPrincipalName: 'alice@',
        password: 'P@ssw0rd!',
      })
    ).rejects.toBeInstanceOf(McpError);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
