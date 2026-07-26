import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../src/services/cipp.service.js';
import { Logger } from '../src/utils/logger.js';
import { jsonResponse, bodyOf } from './helpers.js';

const logger = new Logger('error');

// Regression guard for #76. Three defects in one method:
//   1. Add-CIPPScheduledTask stores $task.Name; `taskName` landed as ''.
//   2. It casts [int64]$task.ScheduledTime, so an ISO string threw out of
//      Invoke-AddScheduledItem — which has no try/catch — as a raw 500.
//   3. It *returns* error strings for blocked / unknown / duplicate commands,
//      and the entrypoint serves them with a hardcoded HTTP 200.
describe('CippService addScheduledItem', () => {
  let svc: CippService;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;

  const baseItem = {
    taskName: 'Nightly alert sweep',
    command: 'Get-CIPPAlerts',
    scheduledTime: '2026-06-01T09:00:00Z',
  };

  beforeEach(() => {
    svc = new CippService(
      { cipp: { baseUrl: 'https://cipp.example', apiKey: 'test-key' } },
      logger
    );
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
      Promise.resolve(
        jsonResponse({ Results: 'Successfully added task: Nightly alert sweep. It will run in 2 hours.' })
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends Name, not taskName, so the task is findable in the scheduler', async () => {
    await svc.addScheduledItem(baseItem);

    const body = bodyOf(fetchMock, '/api/AddScheduledItem');
    expect(body.Name).toBe('Nightly alert sweep');
    expect(body.taskName).toBeUndefined();
  });

  it('sends Command as a { value } object', async () => {
    await svc.addScheduledItem(baseItem);

    expect(bodyOf(fetchMock, '/api/AddScheduledItem').Command).toEqual({ value: 'Get-CIPPAlerts' });
  });

  it('converts an ISO 8601 scheduledTime to Unix epoch seconds', async () => {
    await svc.addScheduledItem(baseItem);

    const body = bodyOf(fetchMock, '/api/AddScheduledItem');
    expect(body.ScheduledTime).toBe(Math.floor(Date.parse('2026-06-01T09:00:00Z') / 1000));
    expect(typeof body.ScheduledTime).toBe('number');
  });

  it('passes an already-epoch scheduledTime straight through', async () => {
    await svc.addScheduledItem({ ...baseItem, scheduledTime: '1780000000' });

    expect(bodyOf(fetchMock, '/api/AddScheduledItem').ScheduledTime).toBe(1780000000);
  });

  it('rejects an unparseable scheduledTime before sending anything', async () => {
    await expect(
      svc.addScheduledItem({ ...baseItem, scheduledTime: 'next tuesday-ish' })
    ).rejects.toBeInstanceOf(McpError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards recurrence, tenantFilter and Parameters when supplied', async () => {
    await svc.addScheduledItem({
      ...baseItem,
      recurrence: '1d',
      tenantFilter: 'contoso.com',
      parameters: { TenantFilter: 'contoso.com', Days: 7 },
    });

    const body = bodyOf(fetchMock, '/api/AddScheduledItem');
    expect(body.Recurrence).toBe('1d');
    expect(body.TenantFilter).toBe('contoso.com');
    expect(body.Parameters).toEqual({ TenantFilter: 'contoso.com', Days: 7 });
  });

  it('omits optional keys entirely when not supplied', async () => {
    await svc.addScheduledItem(baseItem);

    const body = bodyOf(fetchMock, '/api/AddScheduledItem');
    expect(body).not.toHaveProperty('Recurrence');
    expect(body).not.toHaveProperty('TenantFilter');
    expect(body).not.toHaveProperty('Parameters');
  });

  it('reports success when CIPP confirms the task was added', async () => {
    const result = (await svc.addScheduledItem(baseItem)) as {
      status: string;
      failures: string[];
    };

    expect(result.status).toBe('added');
    expect(result.failures).toHaveLength(0);
  });

  it.each([
    "Error - The command 'Get-Nope' does not exist and cannot be scheduled.",
    "Error - The command 'Remove-Everything' is not permitted to run as a scheduled task.",
    'Task with name Nightly alert sweep already exists',
    'Error - Could not add task: table write failed',
  ])('treats the HTTP 200 error string %j as a failure', async (results) => {
    fetchMock.mockResolvedValue(jsonResponse({ Results: results }));

    const result = (await svc.addScheduledItem(baseItem)) as {
      status: string;
      failures: string[];
      message: string;
    };

    expect(result.status).toBe('failed');
    expect(result.failures).toEqual([results]);
    expect(result.message).toMatch(/do not report success/i);
  });
});
