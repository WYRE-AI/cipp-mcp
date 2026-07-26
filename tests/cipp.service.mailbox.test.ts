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

  it('sends userId and AutoReplyState, not UserPrincipalName / enabled', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Enabled',
      internalMessage: 'Away until Monday',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.userId).toBe(UPN);
    expect(body.AutoReplyState).toBe('Enabled');
    expect(body.UserPrincipalName).toBeUndefined();
    expect(body.enabled).toBeUndefined();
    expect(body.InternalMessage).toBe('Away until Monday');
  });

  it('passes Disabled straight through as the auto-reply state', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, { state: 'Disabled' });

    expect(bodyOf(fetchMock, '/api/ExecSetOoO').AutoReplyState).toBe('Disabled');
  });

  it('omits empty messages so disabling keeps the existing text intact', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Disabled',
      internalMessage: '',
      externalMessage: '   ',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.InternalMessage).toBeUndefined();
    expect(body.ExternalMessage).toBeUndefined();
  });

  it('sends both messages in CIPP\'s capitalised form when supplied', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Enabled',
      internalMessage: 'Internal text',
      externalMessage: 'External text',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.InternalMessage).toBe('Internal text');
    expect(body.ExternalMessage).toBe('External text');
    expect(body.internalMessage).toBeUndefined();
    expect(body.externalMessage).toBeUndefined();
  });

  // A stale caller still sending the old boolean must fail loudly. Defaulting
  // would silently disable the auto-reply for someone asking to enable it.
  it.each([
    ['the old boolean enabled=true', { enabled: true }],
    ['a missing state', {}],
    ['an unrecognised state', { state: 'On' }],
  ])('rejects %s rather than guessing', async (_label, input) => {
    await expect(
      svc.setOutOfOffice('contoso.com', UPN, input as never)
    ).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Scheduled auto-replies (#75 follow-up). Invoke-ExecSetOoO reads StartTime /
// EndTime and the calendar options only inside its `$State -eq 'Scheduled'`
// branch, converting a `^\d+$` value via FromUnixTimeSeconds — so epoch is the
// unambiguous form to send.
describe('CippService setOutOfOffice (Scheduled)', () => {
  let svc: CippService;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;

  const START = '2026-08-01T09:00:00Z';
  const END = '2026-08-08T17:00:00Z';
  const startEpoch = Math.floor(Date.parse(START) / 1000);
  const endEpoch = Math.floor(Date.parse(END) / 1000);

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

  it('converts an ISO window to Unix epoch seconds', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Scheduled',
      startTime: START,
      endTime: END,
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.AutoReplyState).toBe('Scheduled');
    expect(body.StartTime).toBe(startEpoch);
    expect(body.EndTime).toBe(endEpoch);
  });

  it('passes an already-epoch window straight through', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Scheduled',
      startTime: String(startEpoch),
      endTime: String(endEpoch),
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.StartTime).toBe(startEpoch);
    expect(body.EndTime).toBe(endEpoch);
  });

  it('sends the calendar options in CIPP\'s capitalised form', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Scheduled',
      startTime: START,
      createOOFEvent: true,
      oofEventSubject: 'On leave',
      autoDeclineFutureRequestsWhenOOF: true,
      declineEventsForScheduledOOF: false,
      declineMeetingMessage: 'Back on the 8th',
    });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.CreateOOFEvent).toBe(true);
    expect(body.OOFEventSubject).toBe('On leave');
    expect(body.AutoDeclineFutureRequestsWhenOOF).toBe(true);
    expect(body.DeclineEventsForScheduledOOF).toBe(false);
    expect(body.DeclineMeetingMessage).toBe('Back on the 8th');
  });

  it('omits a window entirely when not supplied, letting CIPP default it', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, { state: 'Scheduled' });

    const body = bodyOf(fetchMock, '/api/ExecSetOoO');
    expect(body.AutoReplyState).toBe('Scheduled');
    expect(body).not.toHaveProperty('StartTime');
    expect(body).not.toHaveProperty('EndTime');
  });

  it('sends timezone for any state, since upstream applies it outside the Scheduled branch', async () => {
    await svc.setOutOfOffice('contoso.com', UPN, {
      state: 'Enabled',
      timezone: 'Eastern Standard Time',
    });

    expect(bodyOf(fetchMock, '/api/ExecSetOoO').timezone).toBe('Eastern Standard Time');
  });

  it('rejects an endTime that is not after startTime', async () => {
    await expect(
      svc.setOutOfOffice('contoso.com', UPN, {
        state: 'Scheduled',
        startTime: END,
        endTime: START,
      })
    ).rejects.toThrow(/must be after/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unparseable startTime naming the offending field', async () => {
    await expect(
      svc.setOutOfOffice('contoso.com', UPN, { state: 'Scheduled', startTime: 'soon' })
    ).rejects.toThrow(/startTime must be an ISO 8601/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['startTime', 'oofEventSubject', 'createOOFEvent'])(
    'rejects the scheduled-only field %s when the state is not Scheduled',
    async (field) => {
      const value = field === 'createOOFEvent' ? true : START;
      await expect(
        svc.setOutOfOffice('contoso.com', UPN, {
          state: 'Enabled',
          [field]: value,
        } as never)
      ).rejects.toThrow(/only applies when state is "Scheduled"/i);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
