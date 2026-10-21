import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse } from './helpers.js';

const logger = new Logger('error');

// CIPP's Set-CIPPResetPassword always generates the password itself and
// ignores any supplied one, so the request must not carry one.
describe('CippService resetPassword', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts ExecResetPass with tenantFilter and ID only, no newPassword', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: { resultText: 'ok' } }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );

    await svc.resetPassword('contoso.com', '11111111-1111-1111-1111-111111111111');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/ExecResetPass');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ tenantFilter: 'contoso.com', ID: '11111111-1111-1111-1111-111111111111' });
    expect(body).not.toHaveProperty('newPassword');
  });
});
