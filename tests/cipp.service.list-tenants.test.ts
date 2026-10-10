// Invoke-ListTenants reads AllTenantSelector from the query string and CIPP
// documents the call as GET. A POST body never reached that parameter.

import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse } from './helpers.js';

const logger = new Logger('error');

describe('CippService listTenants', () => {
  let svc: CippService;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit?]>;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>(() =>
      Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses GET', async () => {
    await svc.listTenants();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('GET');
    expect(url).toContain('/api/ListTenants');
    expect(init?.body).toBeUndefined();
    expect(new URL(url).searchParams.has('AllTenantSelector')).toBe(false);
  });

  it('sends AllTenantSelector as a query parameter', async () => {
    await svc.listTenants({ allTenants: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(new URL(url).searchParams.get('AllTenantSelector')).toBe('true');
  });

  it('sends AllTenantSelector=false when the caller asks to omit the all-tenants row', async () => {
    await svc.listTenants({ allTenants: false });

    const [url, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('GET');
    expect(new URL(url).searchParams.get('AllTenantSelector')).toBe('false');
  });
});
