import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse, bodyOf, calledEndpoint } from './helpers.js';

const logger = new Logger('error');

const UPN = 'alice@contoso.com';

// Regression guard for #74: Invoke-ExecEmailForward switches on `forwardOption`
// and assigns a status code only inside a matching branch. With none sent, the
// PowerShell worker crashed building a null-StatusCode response — an opaque 500
// in every mode, so the tool had never worked at all.
describe('CippService setEmailForwarding', () => {
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

  function mockCipp(domains: Array<{ id?: string }> = [{ id: 'contoso.com' }]) {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListDomains')) return Promise.resolve(jsonResponse(domains));
      if (url.includes('/api/ExecEmailForward')) {
        return Promise.resolve(jsonResponse({ Results: ['Success'] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('sends forwardOption=disabled and userID when disabling', async () => {
    const fetchMock = mockCipp();

    await svc.setEmailForwarding('contoso.com', UPN, {});

    const body = bodyOf(fetchMock, '/api/ExecEmailForward');
    expect(body.forwardOption).toBe('disabled');
    expect(body.userID).toBe(UPN);
    expect(body.UserPrincipalName).toBeUndefined();
    // Disabling must not pay for a domain lookup.
    expect(calledEndpoint(fetchMock, '/api/ListDomains')).toBe(false);
  });

  it('treats a blank forwardTo as a disable request', async () => {
    const fetchMock = mockCipp();

    await svc.setEmailForwarding('contoso.com', UPN, { forwardTo: '   ', keepCopy: false });

    expect(bodyOf(fetchMock, '/api/ExecEmailForward').forwardOption).toBe('disabled');
  });

  it('uses internalAddress with a { value } payload for a tenant domain', async () => {
    const fetchMock = mockCipp([{ id: 'contoso.com' }, { id: 'contoso.onmicrosoft.com' }]);

    await svc.setEmailForwarding('contoso.com', UPN, { forwardTo: 'bob@contoso.com' });

    const body = bodyOf(fetchMock, '/api/ExecEmailForward');
    expect(body.forwardOption).toBe('internalAddress');
    expect(body.ForwardInternal).toEqual({ value: 'bob@contoso.com' });
    expect(body.ForwardExternal).toBeUndefined();
    expect(body.userID).toBe(UPN);
  });

  it('uses ExternalAddress — capital E — for a domain outside the tenant', async () => {
    const fetchMock = mockCipp([{ id: 'contoso.com' }]);

    await svc.setEmailForwarding('contoso.com', UPN, { forwardTo: 'bob@fabrikam.com' });

    const body = bodyOf(fetchMock, '/api/ExecEmailForward');
    expect(body.forwardOption).toBe('ExternalAddress');
    expect(body.ForwardExternal).toBe('bob@fabrikam.com');
    expect(body.ForwardInternal).toBeUndefined();
  });

  it('matches tenant domains case-insensitively', async () => {
    const fetchMock = mockCipp([{ id: 'Contoso.COM' }]);

    await svc.setEmailForwarding('contoso.com', UPN, { forwardTo: 'bob@CONTOSO.com' });

    expect(bodyOf(fetchMock, '/api/ExecEmailForward').forwardOption).toBe('internalAddress');
  });

  it('sends KeepCopy as the string upstream compares against', async () => {
    const fetchMock = mockCipp();

    await svc.setEmailForwarding('contoso.com', UPN, {
      forwardTo: 'bob@fabrikam.com',
      keepCopy: true,
    });
    expect(bodyOf(fetchMock, '/api/ExecEmailForward').KeepCopy).toBe('true');

    const second = mockCipp();
    await svc.setEmailForwarding('contoso.com', UPN, { forwardTo: 'bob@fabrikam.com' });
    expect(bodyOf(second, '/api/ExecEmailForward').KeepCopy).toBe('false');
  });

  it('rejects a forwardTo that is not an email address', async () => {
    const fetchMock = mockCipp();

    await expect(
      svc.setEmailForwarding('contoso.com', UPN, { forwardTo: 'not-an-address' })
    ).rejects.toBeInstanceOf(McpError);
    expect(calledEndpoint(fetchMock, '/api/ExecEmailForward')).toBe(false);
  });
});

// Regression guard for #75: Invoke-ExecSetOoO reads userId / AutoReplyState.
// The old body sent UserPrincipalName / enabled, both of which resolved to
// $null upstream — the tell was an error naming a blank user.
describe('CippService setOutOfOffice', () => {
  let svc: CippService;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse({ Results: 'Success' }))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends userId and AutoReplyState=Enabled, not UserPrincipalName / enabled', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      enabled: true,
      internalMessage: 'Away until Monday',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.userId).toBe(UPN);
    expect(body.AutoReplyState).toBe('Enabled');
    expect(body.UserPrincipalName).toBeUndefined();
    expect(body.enabled).toBeUndefined();
    expect(body.InternalMessage).toBe('Away until Monday');
  });

  it('maps enabled=false to AutoReplyState=Disabled', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, { enabled: false });

    expect(bodyOf(fetchMock, '/api/ExecSetOoO').AutoReplyState).toBe('Disabled');
  });

  it('omits empty messages so disabling keeps the existing text intact', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      enabled: false,
      internalMessage: '',
      externalMessage: '   ',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.InternalMessage).toBeUndefined();
    expect(body.ExternalMessage).toBeUndefined();
  });

  it('sends both messages in CIPP\'s capitalised form when supplied', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      enabled: true,
      internalMessage: 'Internal text',
      externalMessage: 'External text',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.InternalMessage).toBe('Internal text');
    expect(body.ExternalMessage).toBe('External text');
    expect(body.internalMessage).toBeUndefined();
    expect(body.externalMessage).toBeUndefined();
  });
});
