// Tests for CippService.listDomainHealth.
//
// Regression: the CIPP `ListDomainHealth` Azure Function is a per-domain DNS
// helper that requires `Action` + `Domain` query params and ignores
// `tenantFilter`. Calling it with only `tenantFilter` returns HTTP 200 with an
// empty body, which crashed the old implementation with
// "Unexpected end of JSON input".
//
// The correct flow: enumerate the tenant's domains via `ListDomains`, then run
// SPF / DMARC / DKIM checks against `ListDomainHealth` for each domain.

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

function emptyResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
  } as unknown as Response;
}

describe('CippService.listDomainHealth', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enumerates tenant domains then checks SPF/DMARC/DKIM for each', async () => {
    const fetchMock = jest.fn((url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/api/ListDomains')) {
        return Promise.resolve(jsonResponse([{ id: 'contoso.com' }, { id: 'contoso.net' }]));
      }
      if (u.pathname.endsWith('/api/ListDomainHealth')) {
        return Promise.resolve(
          jsonResponse({ action: u.searchParams.get('Action'), domain: u.searchParams.get('Domain') })
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listDomainHealth('contoso.com')) as unknown as Array<
      Record<string, unknown>
    >;

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ domain: 'contoso.com' });
    expect(result[0].spf).toMatchObject({ action: 'ReadSpfRecord', domain: 'contoso.com' });
    expect(result[0].dmarc).toMatchObject({ action: 'ReadDmarcPolicy', domain: 'contoso.com' });
    expect(result[0].dkim).toMatchObject({ action: 'ReadDkimRecord', domain: 'contoso.com' });

    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls.filter((c) => c.includes('/api/ListDomains')).length).toBe(1);
    // 3 checks (SPF/DMARC/DKIM) x 2 domains
    expect(calls.filter((c) => c.includes('/api/ListDomainHealth')).length).toBe(6);
  });

  it('returns an empty list (no crash) when the tenant has no domains', async () => {
    global.fetch = jest.fn(() => Promise.resolve(emptyResponse())) as unknown as typeof fetch;
    await expect(svc.listDomainHealth('contoso.com')).resolves.toEqual([]);
  });

  it('skips .onmicrosoft.com routing domains', async () => {
    const fetchMock = jest.fn((url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/api/ListDomains')) {
        return Promise.resolve(
          jsonResponse([{ id: 'contoso.com' }, { id: 'contoso.onmicrosoft.com' }])
        );
      }
      return Promise.resolve(jsonResponse({ domain: u.searchParams.get('Domain') }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listDomainHealth('contoso.com')) as unknown as Array<
      Record<string, unknown>
    >;

    // The routing domain carries no real mail DNS, so it is not checked.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ domain: 'contoso.com' });

    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('onmicrosoft.com'))).toBe(false);
  });

  it('bounds each per-domain DNS check with an abort signal', async () => {
    const fetchMock = jest.fn((url: string, _init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/api/ListDomains')) {
        return Promise.resolve(jsonResponse([{ id: 'contoso.com' }]));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.listDomainHealth('contoso.com');

    // Every ListDomainHealth call must carry an AbortSignal so a slow DNS
    // lookup cannot hang the whole tenant response.
    const healthCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes('/api/ListDomainHealth')
    );
    expect(healthCalls).toHaveLength(3);
    for (const call of healthCalls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('captures a failed check as an error placeholder without sinking the tenant', async () => {
    const fetchMock = jest.fn((url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/api/ListDomains')) {
        return Promise.resolve(jsonResponse([{ id: 'contoso.com' }]));
      }
      if (u.searchParams.get('Action') === 'ReadDkimRecord') {
        return Promise.reject(new Error('The operation was aborted due to timeout'));
      }
      return Promise.resolve(jsonResponse({ record: u.searchParams.get('Action') }));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = (await svc.listDomainHealth('contoso.com')) as unknown as Array<
      Record<string, unknown>
    >;

    expect(result).toHaveLength(1);
    expect(result[0].spf).toMatchObject({ record: 'ReadSpfRecord' });
    expect(result[0].dkim).toMatchObject({ error: expect.stringContaining('aborted') });
  });
});
