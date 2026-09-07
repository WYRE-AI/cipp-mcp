import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { GIB } from '../src/utils/bytes.js';
import { jsonResponse, errorResponse, queryOf, calledEndpoint } from './helpers.js';

const logger = new Logger('error');

function service(): CippService {
  return new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

// ---------------------------------------------------------------------------
// Tenant-wide usage — /api/ListMailboxes?UseReportDB=true
//
// Sizes exist only on the cached path: Invoke-ListMailboxes' live Exchange
// query selects no size fields at all. Set-CIPPDBCacheMailboxes writes every
// figure as an int64 byte count, defaulting each to 0.
// ---------------------------------------------------------------------------
describe('CippService listMailboxUsage', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function reportRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      UPN: 'alice@contoso.com',
      displayName: 'Alice Example',
      recipientTypeDetails: 'UserMailbox',
      storageUsedInBytes: 20 * GIB,
      prohibitSendReceiveQuotaInBytes: 50 * GIB,
      MailboxItemCount: 34_000,
      ArchiveEnabled: true,
      ArchiveSize: 5 * GIB,
      ArchiveItemCount: 1_200,
      ArchiveQuota: 100 * GIB,
      AutoExpandingArchive: false,
      CacheTimestamp: '2026-09-01T00:00:00Z',
      ...overrides,
    };
  }

  function mockRows(rows: unknown): FetchMock {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse(rows))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('asks for the reporting database, the only tenant-wide source of sizes', async () => {
    const fetchMock = mockRows([reportRow()]);

    await svc.listMailboxUsage('contoso.com');

    const query = queryOf(fetchMock, '/api/ListMailboxes');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('UseReportDB')).toBe('true');
  });

  it('normalises the primary store to bytes, a readable size and percent of quota', async () => {
    mockRows([reportRow()]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;
    const row = result.mailboxes[0];

    expect(row.userPrincipalName).toBe('alice@contoso.com');
    expect(row.displayName).toBe('Alice Example');
    expect(row.recipientTypeDetails).toBe('UserMailbox');
    expect(row.mailbox).toEqual({
      bytes: 20 * GIB,
      size: '20.00 GB',
      itemCount: 34_000,
      quotaBytes: 50 * GIB,
      quota: '50.00 GB',
      percentOfQuota: 40,
    });
  });

  it('normalises the archive the same way', async () => {
    mockRows([reportRow()]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.mailboxes[0].archive).toEqual({
      enabled: true,
      bytes: 5 * GIB,
      size: '5.00 GB',
      itemCount: 1_200,
      quotaBytes: 100 * GIB,
      quota: '100.00 GB',
      percentOfQuota: 5,
      autoExpanding: false,
    });
  });

  // The cache defaults ArchiveSize/ArchiveItemCount to 0 and only fills them in
  // for mailboxes that actually have an archive. Emitting that 0 would read as
  // "archive exists and is empty", which is a different fact.
  it('reports an absent archive as disabled rather than as zero bytes', async () => {
    mockRows([reportRow({ ArchiveEnabled: false, ArchiveSize: 0, ArchiveItemCount: 0 })]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.mailboxes[0].archive.enabled).toBe(false);
    expect(result.mailboxes[0].archive).not.toHaveProperty('bytes');
    expect(result.mailboxes[0].archive).not.toHaveProperty('size');
  });

  it('sorts by primary mailbox size, largest first, by default', async () => {
    mockRows([
      reportRow({ UPN: 'small@contoso.com', storageUsedInBytes: 1 * GIB }),
      reportRow({ UPN: 'big@contoso.com', storageUsedInBytes: 90 * GIB }),
      reportRow({ UPN: 'mid@contoso.com', storageUsedInBytes: 40 * GIB }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.sortedBy).toBe('mailboxSize');
    expect(result.mailboxes.map((m: any) => m.userPrincipalName)).toEqual([
      'big@contoso.com',
      'mid@contoso.com',
      'small@contoso.com',
    ]);
  });

  it.each([
    ['archiveSize', ['archive-heavy@contoso.com', 'alice@contoso.com']],
    ['totalSize', ['archive-heavy@contoso.com', 'alice@contoso.com']],
    ['percentOfQuota', ['alice@contoso.com', 'archive-heavy@contoso.com']],
  ])('orders by %s when asked', async (sortBy, expected) => {
    mockRows([
      reportRow(),
      reportRow({
        UPN: 'archive-heavy@contoso.com',
        storageUsedInBytes: 2 * GIB,
        ArchiveSize: 80 * GIB,
      }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com', { sortBy })) as any;

    expect(result.mailboxes.map((m: any) => m.userPrincipalName)).toEqual(expected);
  });

  // A mailbox whose size was never measured is not the emptiest mailbox in the
  // tenant, so it must not be ranked as one.
  it('sorts mailboxes with no usable figure last', async () => {
    mockRows([
      reportRow({ UPN: 'unknown@contoso.com', ArchiveEnabled: false }),
      reportRow({ UPN: 'known@contoso.com', ArchiveSize: 3 * GIB }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com', { sortBy: 'archiveSize' })) as any;

    expect(result.mailboxes.map((m: any) => m.userPrincipalName)).toEqual([
      'known@contoso.com',
      'unknown@contoso.com',
    ]);
  });

  // Returning every row of a large tenant is what blew the tool-result limit in
  // cipp_list_users. The totals still have to describe the whole tenant.
  it('limits the rows returned but totals every mailbox', async () => {
    mockRows([
      reportRow({ UPN: 'a@contoso.com', storageUsedInBytes: 10 * GIB, ArchiveEnabled: false }),
      reportRow({ UPN: 'b@contoso.com', storageUsedInBytes: 20 * GIB, ArchiveEnabled: false }),
      reportRow({ UPN: 'c@contoso.com', storageUsedInBytes: 30 * GIB, ArchiveEnabled: false }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com', { limit: 1 })) as any;

    expect(result.mailboxes).toHaveLength(1);
    expect(result.returned).toBe(1);
    expect(result.totalMatching).toBe(3);
    expect(result.summary.mailboxCount).toBe(3);
    expect(result.summary.mailboxBytes).toBe(60 * GIB);
    expect(result.summary.mailboxSize).toBe('60.00 GB');
  });

  it('summarises archives and mailboxes nearing quota', async () => {
    mockRows([
      reportRow({ UPN: 'full@contoso.com', storageUsedInBytes: 48 * GIB }),
      reportRow({ UPN: 'roomy@contoso.com', storageUsedInBytes: 5 * GIB, ArchiveEnabled: false }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.summary.archivesEnabled).toBe(1);
    expect(result.summary.archiveBytes).toBe(5 * GIB);
    expect(result.summary.totalBytes).toBe(58 * GIB);
    expect(result.summary.nearQuotaCount).toBe(1);
    // The threshold travels with the count, so a caller never has to guess it.
    expect(result.summary.nearQuotaPercent).toBe(90);
  });

  it('filters on the primary store and archive combined', async () => {
    mockRows([
      reportRow({ UPN: 'combined@contoso.com', storageUsedInBytes: 6 * GIB, ArchiveSize: 6 * GIB }),
      reportRow({ UPN: 'small@contoso.com', storageUsedInBytes: 1 * GIB, ArchiveSize: 1 * GIB }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com', { minSizeGB: 10 })) as any;

    expect(result.minSizeGB).toBe(10);
    expect(result.totalMatching).toBe(1);
    expect(result.mailboxes[0].userPrincipalName).toBe('combined@contoso.com');
    // The summary still describes the tenant, not the filtered slice.
    expect(result.summary.mailboxCount).toBe(2);
  });

  it('reports the age of the cached data', async () => {
    mockRows([
      reportRow({ CacheTimestamp: '2026-09-01T00:00:00Z' }),
      reportRow({ UPN: 'b@contoso.com', CacheTimestamp: '2026-09-03T00:00:00Z' }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.source).toBe('reportDatabase');
    expect(result.cachedAt).toBe('2026-09-03T00:00:00Z');
  });

  it('accepts the paginated { Results } envelope as well as a bare array', async () => {
    mockRows({ Results: [reportRow()], Metadata: {} });

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.mailboxes).toHaveLength(1);
  });

  // Get-CIPPMailboxesReport throws when the cache has never been synced, and
  // Invoke-ListMailboxes serves that as an HTTP 500 whose body is the bare
  // message — otherwise an opaque server error with no remedy in it.
  it('turns an unsynced report cache into an actionable error', async () => {
    global.fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(
        errorResponse(
          500,
          JSON.stringify(['No mailbox data found in reporting database. Sync the report data first.'])
        )
      )
    ) as unknown as typeof fetch;

    await expect(svc.listMailboxUsage('contoso.com')).rejects.toThrow(
      /no cached mailbox data[\s\S]*cipp_get_mailbox_usage/i
    );
  });

  it('does not swallow unrelated CIPP errors', async () => {
    global.fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(errorResponse(403, 'Forbidden'))
    ) as unknown as typeof fetch;

    await expect(svc.listMailboxUsage('contoso.com')).rejects.toThrow(/403/);
  });

  // With "conceal user, group, and site names" on, the Graph usage report keys
  // on hashes, so Set-CIPPDBCacheMailboxes' join on UPN matches nothing and
  // every mailbox keeps its 0 default. That reads as an empty tenant.
  it('warns when every mailbox reports zero, rather than reporting an empty tenant', async () => {
    mockRows([
      reportRow({ storageUsedInBytes: 0, ArchiveEnabled: false }),
      reportRow({ UPN: 'b@contoso.com', storageUsedInBytes: 0, ArchiveEnabled: false }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.warnings.join(' ')).toMatch(/conceal|failed usage merge/i);
    expect(result.warnings.join(' ')).toMatch(/cipp_get_mailbox_usage/);
  });

  it('warns when mailboxes are identified by a concealed hash instead of a UPN', async () => {
    mockRows([
      reportRow({ UPN: '85926F73B5A9FA60D166E6057BA76F4A', storageUsedInBytes: 12 * GIB }),
    ]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result.warnings.join(' ')).toMatch(/32-character hash/i);
  });

  it('stays quiet when the data looks healthy', async () => {
    mockRows([reportRow()]);

    const result = (await svc.listMailboxUsage('contoso.com')) as any;

    expect(result).not.toHaveProperty('warnings');
  });

  it.each([
    ['an unknown sortBy', { sortBy: 'biggest' }],
    ['a non-integer limit', { limit: 1.5 }],
    ['a limit below 1', { limit: 0 }],
    ['a limit above the cap', { limit: 5000 }],
    ['a negative minSizeGB', { minSizeGB: -1 }],
  ])('rejects %s before calling CIPP', async (_label, params) => {
    const fetchMock = mockRows([]);

    await expect(svc.listMailboxUsage('contoso.com', params as never)).rejects.toBeInstanceOf(
      McpError
    );
    expect(calledEndpoint(fetchMock, '/api/ListMailboxes')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Single mailbox — /api/ListUserMailboxDetails
//
// Invoke-ListUserMailboxDetails returns every size as a gigabyte float, keyed
// off the Entra object id, and includes the raw Get-Mailbox object.
// ---------------------------------------------------------------------------
describe('CippService getMailboxUsage', () => {
  let svc: CippService;
  const OBJECT_ID = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockCipp(details: Record<string, unknown>): FetchMock {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>((url) => {
      if (url.includes('/api/ListUsers')) {
        return Promise.resolve(
          jsonResponse([{ id: OBJECT_ID, userPrincipalName: 'alice@contoso.com' }])
        );
      }
      if (url.includes('/api/ListUserMailboxDetails')) {
        return Promise.resolve(jsonResponse(details));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function details(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      TotalItemSize: 12.3,
      ItemCount: 41_233,
      ProhibitSendReceiveQuota: 50,
      ArchiveMailBox: true,
      TotalArchiveItemSize: 4.5,
      TotalArchiveItemCount: 9_001,
      AutoExpandingArchive: true,
      AutoExpandingArchiveScope: 'Organization',
      RecipientTypeDetails: 'UserMailbox',
      Mailbox: {
        DisplayName: 'Alice Example',
        ProhibitSendReceiveQuota: '50 GB (53,687,091,200 bytes)',
        ArchiveQuota: '100 GB (107,374,182,400 bytes)',
      },
      ...overrides,
    };
  }

  // The endpoint keys off the Entra object id. A UPN in UserID returns an empty
  // shell rather than an error, so the lookup has to resolve first.
  it('resolves the UPN to an object id and queries by that', async () => {
    const fetchMock = mockCipp(details());

    await svc.getMailboxUsage('contoso.com', 'alice@contoso.com');

    const query = queryOf(fetchMock, '/api/ListUserMailboxDetails');
    expect(query.get('UserID')).toBe(OBJECT_ID);
    expect(query.get('userMail')).toBe('alice@contoso.com');
    expect(query.get('tenantFilter')).toBe('contoso.com');
  });

  it('converts the gigabyte figures upstream returns into bytes', async () => {
    mockCipp(details());

    const result = (await svc.getMailboxUsage('contoso.com', 'alice@contoso.com')) as any;

    expect(result.source).toBe('live');
    expect(result.userPrincipalName).toBe('alice@contoso.com');
    expect(result.displayName).toBe('Alice Example');
    expect(result.mailbox.bytes).toBe(Math.round(12.3 * GIB));
    expect(result.mailbox.size).toBe('12.30 GB');
    expect(result.mailbox.itemCount).toBe(41_233);
    expect(result.archive.bytes).toBe(Math.round(4.5 * GIB));
    expect(result.archive.itemCount).toBe(9_001);
    expect(result.archive.autoExpanding).toBe(true);
    expect(result.archive.autoExpandingScope).toBe('Organization');
  });

  // Upstream strips the unit off the quota (`[float]($Quota -split ' ')[0]`), so
  // a quota Exchange prints in TB would come back as a handful of GB. The raw
  // Get-Mailbox string still carries the exact byte count.
  it('recovers the exact quota from the raw Get-Mailbox string', async () => {
    mockCipp(details());

    const result = (await svc.getMailboxUsage('contoso.com', 'alice@contoso.com')) as any;

    expect(result.mailbox.quotaBytes).toBe(53_687_091_200);
    expect(result.archive.quotaBytes).toBe(107_374_182_400);
  });

  it('falls back to the unit-stripped quota when the raw mailbox has none', async () => {
    mockCipp(details({ Mailbox: { DisplayName: 'Alice Example' } }));

    const result = (await svc.getMailboxUsage('contoso.com', 'alice@contoso.com')) as any;

    expect(result.mailbox.quotaBytes).toBe(50 * GIB);
    expect(result.archive.quotaBytes).toBeUndefined();
  });

  it('reports an absent archive as disabled with no measured size', async () => {
    mockCipp(
      details({ ArchiveMailBox: false, TotalArchiveItemSize: 0, TotalArchiveItemCount: 0 })
    );

    const result = (await svc.getMailboxUsage('contoso.com', 'alice@contoso.com')) as any;

    expect(result.archive.enabled).toBe(false);
    expect(result.archive).not.toHaveProperty('bytes');
    expect(result.archive).not.toHaveProperty('itemCount');
  });

  // Upstream has no all-tenants branch for this endpoint, so letting the call
  // through would fan ListUsers across every tenant and then ask for a mailbox
  // against a tenantFilter CIPP cannot resolve.
  it.each(['allTenants', 'AllTenants', '  alltenants  '])(
    'rejects tenantFilter %p instead of fanning out across every tenant',
    async (tenantFilter) => {
      const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
        Promise.resolve(jsonResponse([]))
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(svc.getMailboxUsage(tenantFilter, 'alice@contoso.com')).rejects.toThrow(
        /allTenants is not supported[\s\S]*cipp_list_mailbox_usage/i
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('explains an unresolvable user in read terms, not edit terms', async () => {
    global.fetch = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse([]))
    ) as unknown as typeof fetch;

    await expect(svc.getMailboxUsage('contoso.com', 'ghost@contoso.com')).rejects.toThrow(
      /Entra object id/i
    );
  });
});
