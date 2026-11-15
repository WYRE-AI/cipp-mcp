import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse } from './helpers.js';

const logger = new Logger('error');

// CIPP's Set-CIPPResetPassword always generates the password itself and
// ignores any supplied one, so the request must not carry one.
// ExecResetPass reads MustChange from query or body (boolean); omitted → false.
describe('CippService resetPassword', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function service(): CippService {
    return new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
  }

  it('posts ExecResetPass with MustChange false when omitted, no newPassword', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: { resultText: 'ok' } }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = service();

    await svc.resetPassword('contoso.com', '11111111-1111-1111-1111-111111111111');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/ExecResetPass');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      tenantFilter: 'contoso.com',
      ID: '11111111-1111-1111-1111-111111111111',
      MustChange: false,
    });
    expect(body).not.toHaveProperty('newPassword');
  });

  it('posts MustChange false when mustChange is explicitly false', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: { resultText: 'ok' } }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await service().resetPassword(
      'contoso.com',
      '11111111-1111-1111-1111-111111111111',
      false
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.MustChange).toBe(false);
  });

  it('posts MustChange true when mustChange is true', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: { resultText: 'ok' } }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await service().resetPassword(
      'contoso.com',
      '11111111-1111-1111-1111-111111111111',
      true
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/ExecResetPass');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      tenantFilter: 'contoso.com',
      ID: '11111111-1111-1111-1111-111111111111',
      MustChange: true,
    });
  });
});
