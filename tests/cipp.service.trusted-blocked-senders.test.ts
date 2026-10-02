import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse, errorResponse, queryOf, calledEndpoint } from './helpers.js';

const logger = new Logger('error');

const UPN = 'alice@contoso.com';

function service(): CippService {
  return new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

function mockRows(rows: unknown): FetchMock {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(jsonResponse(rows))
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// Shaped against Invoke-ListUserTrustedBlockedSenders.ps1 (CyberDrain/CIPP,
// dev branch): calls Get-MailboxJunkEmailConfiguration -Identity <UserId>,
// anchored on the same value. UserId drives which mailbox is actually read;
// userPrincipalName is only echoed back into each row's label. Both carry
// the same UPN here, matching every other EXO-identity call in this service.
describe('CippService listTrustedBlockedSenders', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends UserId and userPrincipalName as the same UPN', async () => {
    const fetchMock = mockRows([]);

    await svc.listTrustedBlockedSenders('contoso.com', UPN);

    const query = queryOf(fetchMock, '/api/ListUserTrustedBlockedSenders');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('UserId')).toBe(UPN);
    expect(query.get('userPrincipalName')).toBe(UPN);
  });

  it('returns an empty list when the mailbox has no entries configured', async () => {
    const fetchMock = mockRows([]);

    const result = await svc.listTrustedBlockedSenders<unknown[]>('contoso.com', UPN);

    expect(result).toEqual([]);
    expect(calledEndpoint(fetchMock, '/api/ListUserTrustedBlockedSenders')).toBe(true);
  });

  it('passes through trusted and blocked rows as upstream shapes them', async () => {
    const rows = [
      {
        UserPrincipalName: UPN,
        UserID: UPN,
        Type: 'Trusted Sender/Domain',
        TypeProperty: 'TrustedSendersAndDomains',
        Value: 'newsletter@example.com',
      },
      {
        UserPrincipalName: UPN,
        UserID: UPN,
        Type: 'Blocked Sender/Domain',
        TypeProperty: 'BlockedSendersAndDomains',
        Value: 'spam.example.com',
      },
    ];
    mockRows(rows);

    const result = await svc.listTrustedBlockedSenders('contoso.com', UPN);

    expect(result).toEqual(rows);
  });

  it('surfaces the upstream error on a non-2xx response', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(
        errorResponse(500, 'Failed to retrieve junk email configuration for alice : Error: Mailbox not found')
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.listTrustedBlockedSenders('contoso.com', UPN)).rejects.toThrow(/Mailbox not found/);
  });
});
