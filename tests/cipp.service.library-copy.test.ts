import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  CippService,
  LibraryCopyInput,
  validateLibraryFolderName,
} from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse, errorResponse, bodyOf, queryOf, calledEndpoint } from './helpers.js';

const logger = new Logger('error');

function service(): CippService {
  return new CippService({ cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } }, logger);
}

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

function mockFetch(response: Response): FetchMock {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(response)
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const SOURCE_SITE = 'contoso-my.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222';
const DEST_SITE = 'contoso.sharepoint.com,33333333-3333-3333-3333-333333333333,44444444-4444-4444-4444-444444444444';

function copyInput(overrides: Partial<LibraryCopyInput> = {}): LibraryCopyInput {
  return {
    tenantFilter: 'contoso.com',
    sourceSiteId: SOURCE_SITE,
    sourceListId: 'aaaaaaaa-0000-0000-0000-000000000001',
    destSiteId: DEST_SITE,
    destListId: 'bbbbbbbb-0000-0000-0000-000000000002',
    ...overrides,
  };
}

/** What Start-CIPPSharePointLibraryCopy returns in StartLibraryCopy mode. */
const STARTED = {
  Results: { OperationId: 'op-123', JobHandleCount: 4, Message: 'Library copy started.' },
};

// ---------------------------------------------------------------------------
// Start — POST /api/ExecSiteBrowserLibraryCopy
//
// Invoke-ExecSiteBrowserLibraryCopy reads Action, tenantFilter, Source*/Dest*
// ids, urls and labels, and NameConflictBehavior ('Fail' | 'Replace'). Every
// failure is HTTP 400 with the reason as a string in Results.
// ---------------------------------------------------------------------------
describe('CippService startLibraryCopy', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the body Invoke-ExecSiteBrowserLibraryCopy reads, with no DestFolderName when none is given', async () => {
    const fetchMock = mockFetch(jsonResponse(STARTED));

    await svc.startLibraryCopy(copyInput());

    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(bodyOf(fetchMock, '/api/ExecSiteBrowserLibraryCopy')).toEqual({
      tenantFilter: 'contoso.com',
      Action: 'StartLibraryCopy',
      SourceSiteId: SOURCE_SITE,
      SourceListId: 'aaaaaaaa-0000-0000-0000-000000000001',
      DestSiteId: DEST_SITE,
      DestListId: 'bbbbbbbb-0000-0000-0000-000000000002',
    });
  });

  it('sends DestFolderName, trimmed, when a folder is requested', async () => {
    const fetchMock = mockFetch(jsonResponse(STARTED));

    await svc.startLibraryCopy(copyInput({ destFolderName: '  Archive - jane@contoso.com  ' }));

    const body = bodyOf(fetchMock, '/api/ExecSiteBrowserLibraryCopy');
    expect(body.DestFolderName).toBe('Archive - jane@contoso.com');
    expect(body.Action).toBe('StartLibraryCopy');
  });

  it('passes the optional urls, labels and conflict behaviour in upstream casing', async () => {
    const fetchMock = mockFetch(jsonResponse(STARTED));

    await svc.startLibraryCopy(
      copyInput({
        sourceSiteUrl: 'https://contoso-my.sharepoint.com/personal/jane_contoso_com',
        destSiteUrl: 'https://contoso.sharepoint.com/sites/Archive',
        sourceSiteName: 'Jane OneDrive',
        sourceLibraryName: 'Documents',
        destSiteName: 'Archive',
        destLibraryName: 'Leavers',
        nameConflictBehavior: 'Fail',
      })
    );

    expect(bodyOf(fetchMock, '/api/ExecSiteBrowserLibraryCopy')).toMatchObject({
      SourceSiteUrl: 'https://contoso-my.sharepoint.com/personal/jane_contoso_com',
      DestSiteUrl: 'https://contoso.sharepoint.com/sites/Archive',
      SourceSiteName: 'Jane OneDrive',
      SourceLibraryName: 'Documents',
      DestSiteName: 'Archive',
      DestLibraryName: 'Leavers',
      NameConflictBehavior: 'Fail',
    });
  });

  it('returns the operation id and points the caller at the status tool', async () => {
    mockFetch(jsonResponse(STARTED));

    const result = (await svc.startLibraryCopy(copyInput())) as any;

    expect(result.status).toBe('started');
    expect(result.operationId).toBe('op-123');
    expect(result.jobHandleCount).toBe(4);
    expect(result.nextStep).toContain('cipp_get_library_copy_status');
    expect(result.nextStep).toContain('op-123');
    expect(result.message).toMatch(/not that they finished/);
    expect(result).not.toHaveProperty('warnings');
  });

  it('warns when CIPP does not confirm DestFolderName, as an unpatched build would not', async () => {
    mockFetch(jsonResponse(STARTED));

    const result = (await svc.startLibraryCopy(copyInput({ destFolderName: 'Archive - jane' }))) as any;

    expect(result.status).toBe('started');
    expect(result.destFolderName).toBe('Archive - jane');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/library root/);
  });

  it('does not warn when CIPP echoes the folder it copied into', async () => {
    mockFetch(
      jsonResponse({ Results: { ...STARTED.Results, DestFolderName: 'Archive - jane' } })
    );

    const result = (await svc.startLibraryCopy(copyInput({ destFolderName: 'Archive - jane' }))) as any;

    expect(result).not.toHaveProperty('warnings');
  });

  it('runs PreflightLibraryCopy when preflightOnly is set, and says nothing was copied', async () => {
    const fetchMock = mockFetch(
      jsonResponse({
        Results: { EligibleRootCount: 120, WarnLevel: 'soft', Message: 'Estimated SharePoint jobs: 120.' },
      })
    );

    const result = (await svc.startLibraryCopy(copyInput({ preflightOnly: true }))) as any;

    expect(bodyOf(fetchMock, '/api/ExecSiteBrowserLibraryCopy').Action).toBe('PreflightLibraryCopy');
    expect(result.status).toBe('preflight');
    expect(result.eligibleRootCount).toBe(120);
    expect(result.warnLevel).toBe('soft');
    expect(result.message).toMatch(/Nothing was copied/);
    expect(result).not.toHaveProperty('operationId');
  });

  it.each([
    ['a forward slash', 'Archive/jane'],
    ['a backslash', 'Archive\\jane'],
    ['a colon', 'Archive: jane'],
    ['an asterisk', 'Archive*'],
    ['a question mark', 'Archive?'],
    ['a double quote', 'Archive "jane"'],
    ['angle brackets', 'Archive <jane>'],
    ['a pipe', 'Archive | jane'],
    ['only dots', '..'],
    ['only dots and spaces', ' . . '],
    ['only whitespace', '   '],
    ['the empty string', ''],
    ['a control character', 'Archive\njane'],
    ['a leading ~$', '~$archive'],
    ['_vti_', 'my_VTI_folder'],
    ['the reserved name Forms', 'forms'],
    ['the reserved name CON', 'CON'],
    ['the reserved name LPT1', 'lpt1'],
    ['the reserved name desktop.ini', 'Desktop.ini'],
    ['256 characters', 'a'.repeat(256)],
  ])('rejects a folder name containing %s without calling CIPP', async (_label, name) => {
    const fetchMock = mockFetch(jsonResponse(STARTED));

    await expect(svc.startLibraryCopy(copyInput({ destFolderName: name }))).rejects.toThrow(McpError);
    expect(calledEndpoint(fetchMock, 'ExecSiteBrowserLibraryCopy')).toBe(false);
  });

  it.each([
    ['sourceSiteId', { sourceSiteId: '' }],
    ['sourceListId', { sourceListId: '  ' }],
    ['destSiteId', { destSiteId: undefined as unknown as string }],
    ['destListId', { destListId: '' }],
  ])('rejects a missing %s client-side', async (field, overrides) => {
    const fetchMock = mockFetch(jsonResponse(STARTED));

    await expect(svc.startLibraryCopy(copyInput(overrides))).rejects.toThrow(field);
    expect(calledEndpoint(fetchMock, 'ExecSiteBrowserLibraryCopy')).toBe(false);
  });

  it('rejects allTenants, copying the same library onto itself, and unknown conflict behaviours', async () => {
    const fetchMock = mockFetch(jsonResponse(STARTED));

    await expect(svc.startLibraryCopy(copyInput({ tenantFilter: 'AllTenants' }))).rejects.toThrow(
      /allTenants/
    );
    await expect(
      svc.startLibraryCopy(
        copyInput({ destSiteId: SOURCE_SITE, destListId: 'aaaaaaaa-0000-0000-0000-000000000001' })
      )
    ).rejects.toThrow(/must be different/);
    await expect(
      svc.startLibraryCopy(copyInput({ nameConflictBehavior: 'Rename' as any }))
    ).rejects.toThrow(/nameConflictBehavior/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the upstream reason when CIPP answers HTTP 400', async () => {
    mockFetch(
      errorResponse(
        400,
        JSON.stringify({
          Results:
            "Failed to run Action 'StartLibraryCopy'. Error: Source library has 1500 eligible root items (limit 1,000).",
        })
      )
    );

    await expect(svc.startLibraryCopy(copyInput())).rejects.toThrow(
      /CIPP refused the library copy: Failed to run Action 'StartLibraryCopy'.*limit 1,000/
    );
  });

  it('never reports a start when HTTP 200 carries a failure string instead of a result', async () => {
    mockFetch(jsonResponse({ Results: "Failed to run Action 'StartLibraryCopy'. Error: boom" }));

    await expect(svc.startLibraryCopy(copyInput())).rejects.toThrow(/Do NOT report that a copy started/);
  });

  it('never reports a start when HTTP 200 carries no OperationId', async () => {
    mockFetch(jsonResponse({ Results: { Message: 'Library copy started.' } }));

    await expect(svc.startLibraryCopy(copyInput())).rejects.toThrow(/no OperationId/);
  });
});

describe('validateLibraryFolderName', () => {
  it('trims and accepts ordinary names, including an address', () => {
    expect(validateLibraryFolderName('  Archive - jane@contoso.com ')).toBe('Archive - jane@contoso.com');
    expect(validateLibraryFolderName('Leavers 2026.09')).toBe('Leavers 2026.09');
    expect(validateLibraryFolderName('a'.repeat(255))).toHaveLength(255);
    expect(validateLibraryFolderName('Forms archive')).toBe('Forms archive');
    expect(validateLibraryFolderName('CON 2026')).toBe('CON 2026');
  });
});

describe('startLibraryCopy with a patched CIPP', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports whether the folder was created on start', async () => {
    mockFetch(
      jsonResponse({
        Results: { ...STARTED.Results, DestFolderName: 'Archive - jane', DestFolderCreated: true },
      })
    );

    const result = (await service().startLibraryCopy(copyInput({ destFolderName: 'Archive - jane' }))) as any;

    expect(result.destFolderCreated).toBe(true);
    expect(result).not.toHaveProperty('warnings');
  });

  it('reports DestFolderExists on preflight and does not warn when the folder is echoed', async () => {
    mockFetch(
      jsonResponse({
        Results: {
          EligibleRootCount: 3,
          WarnLevel: 'none',
          Message: 'Estimated SharePoint jobs: 3.',
          DestFolderName: 'Archive - jane',
          DestFolderExists: false,
        },
      })
    );

    const result = (await service().startLibraryCopy(
      copyInput({ destFolderName: 'Archive - jane', preflightOnly: true })
    )) as any;

    expect(result.destFolderExists).toBe(false);
    expect(result).not.toHaveProperty('warnings');
  });

  it('warns on preflight when an unpatched CIPP ignores DestFolderName', async () => {
    mockFetch(
      jsonResponse({
        Results: { EligibleRootCount: 3, WarnLevel: 'none', Message: 'Estimated SharePoint jobs: 3.' },
      })
    );

    const result = (await service().startLibraryCopy(
      copyInput({ destFolderName: 'Archive - jane', preflightOnly: true })
    )) as any;

    expect(result).not.toHaveProperty('destFolderExists');
    expect(result.warnings[0]).toMatch(/library ROOT/);
  });
});

// ---------------------------------------------------------------------------
// Status — GET /api/ListSiteBrowserLibraryCopy?tenantFilter=&OperationId=
//
// Update-CIPPSharePointLibraryCopyStatus returns Status in Processing |
// Completed | CompletedWithErrors | Failed, with Errors/Warnings as
// { Severity, Message } objects.
// ---------------------------------------------------------------------------
describe('CippService getLibraryCopyStatus', () => {
  let svc: CippService;

  beforeEach(() => {
    svc = service();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function snapshot(overrides: Record<string, unknown> = {}): { Results: Record<string, unknown> } {
    return {
      Results: {
        OperationId: 'op-123',
        Status: 'Processing',
        JobsComplete: 1,
        JobsTotal: 4,
        ObjectsProcessed: 10,
        TotalExpectedObjects: 40,
        ProgressPercent: 25,
        FilesCreated: 8,
        BytesProcessed: 1048576,
        TotalErrors: 0,
        TotalWarnings: 0,
        Errors: [],
        Warnings: [],
        LastUpdatedUtc: '2026-09-25T12:00:00Z',
        Message: 'Copy in progress.',
        SourceSiteName: 'Jane OneDrive',
        SourceLibraryName: 'Documents',
        DestSiteName: 'Archive',
        DestLibraryName: 'Leavers',
        ...overrides,
      },
    };
  }

  it('queries with tenantFilter and OperationId in upstream casing', async () => {
    const fetchMock = mockFetch(jsonResponse(snapshot()));

    await svc.getLibraryCopyStatus('contoso.com', 'op-123');

    const query = queryOf(fetchMock, '/api/ListSiteBrowserLibraryCopy');
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('OperationId')).toBe('op-123');
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it.each([
    ['Queued', {}, 'queued', false],
    ['Processing', { JobsComplete: 0, ObjectsProcessed: 0 }, 'queued', false],
    ['Processing', {}, 'running', false],
    ['Completed', { JobsComplete: 4 }, 'succeeded', true],
    ['Completed', { TotalErrors: 2 }, 'partial', true],
    ['CompletedWithErrors', { TotalErrors: 3, FilesCreated: 5 }, 'partial', true],
    ['CompletedWithErrors', { TotalErrors: 3, FilesCreated: 0, ObjectsProcessed: 0 }, 'failed', true],
    ['Failed', { TotalErrors: 1 }, 'failed', true],
    ['SomethingNew', {}, 'unknown', false],
  ])('normalises upstream %s (%j) to %s', async (status, overrides, state, done) => {
    mockFetch(jsonResponse(snapshot({ Status: status, ...overrides })));

    const result = (await svc.getLibraryCopyStatus('contoso.com', 'op-123')) as any;

    expect(result.upstreamStatus).toBe(status);
    expect(result.state).toBe(state);
    expect(result.done).toBe(done);
  });

  it('reports progress figures, a readable byte count and the library labels', async () => {
    mockFetch(jsonResponse(snapshot()));

    const result = (await svc.getLibraryCopyStatus('contoso.com', 'op-123')) as any;

    expect(result).toMatchObject({
      operationId: 'op-123',
      jobsComplete: 1,
      jobsTotal: 4,
      objectsProcessed: 10,
      totalExpectedObjects: 40,
      progressPercent: 25,
      filesCreated: 8,
      bytesProcessed: 1048576,
      source: { siteName: 'Jane OneDrive', libraryName: 'Documents' },
      destination: { siteName: 'Archive', libraryName: 'Leavers' },
    });
    expect(result.bytesCopied).toMatch(/MB/);
  });

  it('surfaces per-item errors and warnings and refuses to call a partial copy a success', async () => {
    mockFetch(
      jsonResponse(
        snapshot({
          Status: 'CompletedWithErrors',
          JobsComplete: 4,
          TotalErrors: 2,
          TotalWarnings: 1,
          Errors: [
            { Severity: 'Error', Message: 'File: [file] is locked for editing.' },
            { Severity: 'Error', Message: 'Folder: Access denied.' },
          ],
          Warnings: [{ Severity: 'Warning', Message: 'File: version history truncated.' }],
        })
      )
    );

    const result = (await svc.getLibraryCopyStatus('contoso.com', 'op-123')) as any;

    expect(result.state).toBe('partial');
    expect(result.errors).toEqual(['File: [file] is locked for editing.', 'Folder: Access denied.']);
    expect(result.warnings).toEqual(['File: version history truncated.']);
    expect(result.message).toMatch(/Do NOT report this as a clean success/);
  });

  it('explains that an upstream Failed stops tracking the remaining jobs', async () => {
    mockFetch(
      jsonResponse(
        snapshot({
          Status: 'Failed',
          TotalErrors: 1,
          Errors: [{ Severity: 'Error', Message: 'Failed to retrieve copy job progress from SharePoint.' }],
        })
      )
    );

    const result = (await svc.getLibraryCopyStatus('contoso.com', 'op-123')) as any;

    expect(result.state).toBe('failed');
    expect(result.errors).toHaveLength(1);
    expect(result.message).toMatch(/Do NOT report success/);
    expect(result.message).toMatch(/stops tracking/);
  });

  it('reports the destination folder when a patched CIPP records one', async () => {
    mockFetch(jsonResponse(snapshot({ DestFolderName: 'Archive - jane' })));

    const result = (await svc.getLibraryCopyStatus('contoso.com', 'op-123')) as any;

    expect(result.destination.folderName).toBe('Archive - jane');
  });

  it('surfaces "operation not found" from HTTP 400 with a hint about the tenant', async () => {
    mockFetch(
      errorResponse(
        400,
        JSON.stringify({ Results: 'Failed to retrieve library copy status: Library copy operation not found.' })
      )
    );

    await expect(svc.getLibraryCopyStatus('contoso.com', 'op-missing')).rejects.toThrow(
      /operation not found.*tenantFilter/
    );
  });

  it('never reports a status when HTTP 200 carries a failure string', async () => {
    mockFetch(jsonResponse({ Results: 'Failed to retrieve library copy status: boom' }));

    await expect(svc.getLibraryCopyStatus('contoso.com', 'op-123')).rejects.toThrow(
      /Do NOT assume the copy succeeded/
    );
  });

  it('rejects a missing operation id without calling CIPP', async () => {
    const fetchMock = mockFetch(jsonResponse(snapshot()));

    await expect(svc.getLibraryCopyStatus('contoso.com', ' ')).rejects.toThrow(/operationId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
