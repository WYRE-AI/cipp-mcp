import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse } from './helpers.js';

const logger = new Logger('error');

// Regression guard for #73: Invoke-ListUsers reads only tenantFilter, UserID
// and graphFilter. searchField / searchValue were passed straight through and
// silently ignored, returning the entire tenant while appearing to filter.
describe('CippService listUsers', () => {
  let svc: CippService;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(jsonResponse([]))
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function lastQuery(): URLSearchParams {
    const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    return new URL(url).searchParams;
  }

  it('never sends searchField / searchValue on the wire', async () => {
    await svc.listUsers('contoso.com', {
      searchField: 'userPrincipalName',
      searchValue: 'alice@contoso.com',
    });

    const query = lastQuery();
    expect(query.get('searchField')).toBeNull();
    expect(query.get('searchValue')).toBeNull();
  });

  it('translates a userPrincipalName search into an exact graphFilter', async () => {
    await svc.listUsers('contoso.com', {
      searchField: 'userPrincipalName',
      searchValue: 'alice@contoso.com',
    });

    const query = lastQuery();
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('graphFilter')).toBe("userPrincipalName eq 'alice@contoso.com'");
  });

  it('translates a mail search into an exact graphFilter', async () => {
    await svc.listUsers('contoso.com', { searchField: 'mail', searchValue: 'alice@contoso.com' });

    expect(lastQuery().get('graphFilter')).toBe("mail eq 'alice@contoso.com'");
  });

  it('translates a displayName search into a prefix graphFilter', async () => {
    await svc.listUsers('contoso.com', { searchField: 'displayName', searchValue: 'Ali' });

    expect(lastQuery().get('graphFilter')).toBe("startsWith(displayName, 'Ali')");
  });

  it('escapes single quotes in the search value', async () => {
    await svc.listUsers('contoso.com', {
      searchField: 'userPrincipalName',
      searchValue: "o'connor@contoso.com",
    });

    expect(lastQuery().get('graphFilter')).toBe(
      "userPrincipalName eq 'o''connor@contoso.com'"
    );
  });

  it('sends no graphFilter when listing the whole tenant', async () => {
    await svc.listUsers('contoso.com');

    const query = lastQuery();
    expect(query.get('tenantFilter')).toBe('contoso.com');
    expect(query.get('graphFilter')).toBeNull();
  });

  it('tolerates a params object carrying only undefined values', async () => {
    await svc.listUsers('contoso.com', { searchField: undefined, searchValue: undefined });

    expect(lastQuery().get('graphFilter')).toBeNull();
  });

  it.each([
    ['searchField', { searchField: 'displayName' }],
    ['searchValue', { searchValue: 'Ali' }],
  ])('rejects %s without its pair instead of dumping the tenant', async (_label, params) => {
    await expect(svc.listUsers('contoso.com', params)).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
