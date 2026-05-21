// Tests for CippService Standards Template tooling.
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

describe('CippService standards template tooling', () => {
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

  it('listStandardTemplates issues a GET to listStandardTemplates', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([{ GUID: 't1' }]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await svc.listStandardTemplates();

    expect(result).toEqual([{ GUID: 't1' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toMatch(/\/api\/listStandardTemplates$/);
    expect(init.method).toBe('GET');
  });

  it('getTenantDrift GETs ListTenantDrift scoped to a tenant when given one', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantDrift('contoso.com');

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantDrift$/);
    expect(parsed.searchParams.get('tenantFilter')).toBe('contoso.com');
  });

  it('getTenantDrift omits tenantFilter when no tenant is given', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantDrift();

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantDrift$/);
    expect(parsed.searchParams.has('tenantFilter')).toBe(false);
  });

  it('getTenantAlignment GETs ListTenantAlignment scoped to a tenant when given one', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantAlignment('contoso.com');

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantAlignment$/);
    expect(parsed.searchParams.get('tenantFilter')).toBe('contoso.com');
  });

  it('getTenantAlignment omits tenantFilter when no tenant is given', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.getTenantAlignment();

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toMatch(/\/api\/ListTenantAlignment$/);
    expect(parsed.searchParams.has('tenantFilter')).toBe(false);
  });

  it('createStandardTemplate POSTs the template body to AddStandardsTemplate intact', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: 'ok' }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const template = {
      templateName: 'WYRE Baseline',
      tenantFilter: [{ value: 'AllTenants' }],
      standards: { someStandard: {} },
    };
    await svc.createStandardTemplate(template);

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toMatch(/\/api\/AddStandardsTemplate$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(template);
  });

  it('createStandardTemplate rejects a template missing tenantFilter without calling CIPP', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({}))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      svc.createStandardTemplate({ templateName: 'no assignment' })
    ).rejects.toThrow(/must include a "tenantFilter"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a primitive string', 'bad-input'],
  ] as const)(
    'createStandardTemplate rejects a non-object template (%s)',
    async (_label, badInput) => {
      const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
        () => Promise.resolve(jsonResponse({}))
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        svc.createStandardTemplate(badInput as unknown as Record<string, unknown>)
      ).rejects.toThrow(/JSON object/);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('deleteStandardTemplate POSTs RemoveStandardTemplate with the template ID', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(
      () => Promise.resolve(jsonResponse({ Results: 'deleted' }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.deleteStandardTemplate('guid-123');

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toMatch(/\/api\/RemoveStandardTemplate$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ ID: 'guid-123' });
  });
});
