// CIPP API Service
// Wraps all HTTP calls to the CIPP Azure Function App.
// All endpoints live at {baseUrl}/api/{FunctionName} and are authenticated
// with a Bearer token supplied in the Authorization header.

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { TokenProvider } from './token.service.js';
import {
  toBytes,
  formatBytes,
  percentOfQuota,
  fromGigabytes,
  toFiniteNumber,
  GIB,
} from '../utils/bytes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported HTTP methods for the internal request helper. */
type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Shape of the config slice consumed by {@link CippService}. */
interface CippServiceConfig {
  cipp: {
    baseUrl?: string;
    apiKey?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
    tokenScope?: string;
    tokenUrl?: string;
  };
}

/**
 * Group kinds CIPP's `New-CIPPGroup` normalises to. `Generic`, `AzureRole`,
 * `Dynamic` and `M365` are created through Graph; `Distribution`,
 * `DynamicDistribution` and `Security` through Exchange Online.
 */
export const CIPP_GROUP_TYPES = [
  'Generic',
  'Security',
  'M365',
  'Distribution',
  'DynamicDistribution',
  'AzureRole',
  'Dynamic',
] as const;

export type CippGroupType = (typeof CIPP_GROUP_TYPES)[number];

/** The group kinds CIPP needs a mail alias (`username`) for. */
const MAIL_ENABLED_GROUP_TYPES: readonly CippGroupType[] = [
  'M365',
  'Distribution',
  'DynamicDistribution',
  'Security',
];

/** Aggregated DNS health for a single domain (SPF / DMARC / DKIM). */
export interface DomainHealthCheck {
  domain: string;
  spf: unknown;
  dmarc: unknown;
  dkim: unknown;
}

/**
 * Per-check timeout (ms) for `ListDomainHealth` DNS lookups. Each check
 * resolves DNS server-side at CIPP and can be slow; bounding each one keeps
 * a single stuck lookup from hanging the whole tenant response past the
 * MCP gateway's tool-call deadline.
 */
const DOMAIN_HEALTH_CHECK_TIMEOUT_MS = 15_000;

/**
 * The three honest outcomes of a CIPP write.
 *
 * - `confirmed` — a readback proved the change is live in Microsoft, or CIPP
 *   completed the operation inline and reported no failure.
 * - `pending`   — CIPP accepted the write but it could not be confirmed within
 *   the verification budget. NOT a success. Also not a proven failure.
 * - `failed`    — CIPP itself reported the operation did not work.
 */
export type WriteStatus = 'confirmed' | 'pending' | 'failed';

/**
 * The envelope every verified CIPP write returns.
 *
 * It answers the question the technician actually has — "did this land in
 * Microsoft?" — rather than the one CIPP answers, which is "did I accept the
 * job?". `status` is never `confirmed` on the strength of an acknowledgement
 * alone, and `message` never claims success unless it is.
 */
export interface VerifiedWrite {
  status: WriteStatus;
  /** The concrete field or read that would prove the change (e.g. `accountEnabled`). */
  verifiedBy: string;
  /** Human-facing summary. Never claims success while `status !== 'confirmed'`. */
  message: string;
  /** How to confirm by hand. Null once confirmed. */
  recheck: string | null;
  /** Failure strings CIPP reported inside a nominally successful response. */
  failures: string[];
  /** CIPP's raw acknowledgement, kept for auditing. */
  submission: unknown;
}

/**
 * Total polling budget (ms) for a write readback, and the delay between polls.
 *
 * Directory changes propagate in seconds, not instantly. The budget is kept
 * well under a typical MCP gateway tool-call deadline: a slow change should
 * return an honest `pending` rather than time the whole tool call out.
 */
const WRITE_VERIFY_TIMEOUT_MS = 30_000;
const WRITE_VERIFY_INTERVAL_MS = 3_000;

/**
 * CIPP's failure vocabulary as it appears inside a `Results` payload.
 *
 * Several CIPP entrypoints (`Invoke-EditUser`, `Invoke-AddScheduledItem`,
 * `Invoke-ExecOffboardUser`) hardcode HTTP 200 and report failures as plain
 * strings in `Results`, so a `response.ok` check alone reports success on
 * failure.
 */
// Each alternative is anchored to a word boundary so the scan cannot fire on a
// fragment inside opaque content. `ExecResetPass` returns the generated password
// in `Results`; an unanchored /fail/ would report a successful reset as failed
// the moment a random string happened to contain those four letters.
const CIPP_FAILURE_RE =
  /\b(fail|error|could not|unable|not permitted|already exists|does not exist)/i;

/**
 * Normalise a CIPP `Results` payload — a string, an array, or absent — into
 * strings, and flag the entries that report a failure. Parse, never assume.
 *
 * Newer CIPP endpoints return a structured `{ resultText, state }` object
 * instead of a bare string. Where `state` is present it is authoritative and
 * the text scan is skipped, because the text is prose that discusses failure
 * without reporting one — `ExecResetPass` on a directory-synced account
 * succeeds with a `resultText` that reads "…will fail if writeback is not
 * enabled…", which a keyword scan would call a failure.
 */
function interpretResults(raw: unknown): { results: string[]; failures: string[] } {
  let entries: unknown[];
  if (raw === undefined || raw === null) {
    entries = [];
  } else if (Array.isArray(raw)) {
    entries = raw;
  } else {
    // AddScheduledItem returns a bare string where EditUser returns an array.
    entries = [raw];
  }

  const results: string[] = [];
  const failures: string[] = [];

  for (const entry of entries) {
    const structured =
      typeof entry === 'object' && entry !== null
        ? (entry as { resultText?: unknown; state?: unknown })
        : undefined;
    const state = typeof structured?.state === 'string' ? structured.state : undefined;
    const text =
      typeof entry === 'string'
        ? entry
        : typeof structured?.resultText === 'string'
          ? structured.resultText
          : JSON.stringify(entry);

    results.push(text);
    if (state !== undefined ? state !== 'success' : CIPP_FAILURE_RE.test(text)) {
      failures.push(text);
    }
  }

  return { results, failures };
}

/**
 * Parse a Graph timestamp to epoch milliseconds, or `undefined` if it is
 * absent or unparseable. Used to compare a field against its own prior value.
 */
function timestampOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Offboarding actions `Invoke-CIPPOffboardingJob` reads as booleans, in CIPP's
 * own spelling. PowerShell property access is case-insensitive, but keeping
 * upstream's casing keeps this list auditable against the `$Options.<name>`
 * conditions it mirrors.
 *
 * `DisableOneDriveSharing` exists only on newer CIPP builds; older ones ignore
 * it rather than failing.
 */
const OFFBOARD_BOOLEAN_ACTIONS = [
  'ConvertToShared',
  'HideFromGAL',
  'removeCalendarInvites',
  'removePermissions',
  'removeCalendarPermissions',
  'RemoveRules',
  'RemoveMobile',
  'RemoveGroups',
  'RemoveLicenses',
  'RevokeSessions',
  'DisableSignIn',
  'ClearImmutableId',
  'ResetPass',
  'RemoveMFADevices',
  'RemoveTeamsPhoneDID',
  'DeleteUser',
  'DisableOneDriveSharing',
  'disableForwarding',
] as const;

/** Offboarding actions read as arrays of UPNs granted access to the mailbox / OneDrive. */
const OFFBOARD_COLLECTION_ACTIONS = ['AccessNoAutomap', 'AccessAutomap', 'OnedriveAccess'] as const;

/**
 * Convert an ISO 8601 datetime (or an already-epoch value) to Unix seconds.
 *
 * Both callers need this. `Add-CIPPScheduledTask` casts with
 * `[int64]$task.ScheduledTime` — an ISO string fails that cast and, because
 * `Invoke-AddScheduledItem` has no try/catch, surfaces as an unhandled HTTP
 * 500. `Invoke-ExecSetOoO` takes either, converting only when the value
 * matches `^\d+$`, so epoch is the unambiguous form to send.
 *
 * @param value - ISO 8601 datetime or Unix epoch seconds.
 * @param field - Parameter name, used only to make the error actionable.
 */
function toUnixSeconds(value: string, field: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${field} must be an ISO 8601 datetime (e.g. "2026-06-01T09:00:00Z") or Unix epoch seconds; got "${value}".`
    );
  }
  return Math.floor(ms / 1000);
}

/** True when `value` is a string carrying something other than whitespace. */
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Auto-reply states `Set-CIPPOutOfOffice` accepts (its own ValidateSet). */
const OOO_STATES = ['Enabled', 'Disabled', 'Scheduled'] as const;
type OutOfOfficeState = (typeof OOO_STATES)[number];

/**
 * Out-of-office fields `Invoke-ExecSetOoO` reads only inside its
 * `if ($State -eq 'Scheduled')` branch. Supplying them for any other state is
 * rejected rather than silently dropped — a caller passing a window clearly
 * meant to schedule.
 *
 * `timezone` is deliberately absent: upstream applies it outside that branch.
 */
const OOO_SCHEDULED_ONLY_FIELDS = [
  'startTime',
  'endTime',
  'createOOFEvent',
  'oofEventSubject',
  'autoDeclineFutureRequestsWhenOOF',
  'declineEventsForScheduledOOF',
  'declineMeetingMessage',
] as const;

/** Arguments accepted by {@link CippService.setOutOfOffice}. */
export interface OutOfOfficeInput {
  state: OutOfOfficeState;
  internalMessage?: string;
  externalMessage?: string;
  /** Newer CIPP only; older builds ignore it. */
  timezone?: string;
  // Scheduled-only below.
  startTime?: string;
  endTime?: string;
  createOOFEvent?: boolean;
  oofEventSubject?: string;
  autoDeclineFutureRequestsWhenOOF?: boolean;
  declineEventsForScheduledOOF?: boolean;
  declineMeetingMessage?: string;
}

/** Arguments accepted by {@link CippService.addScheduledItem}. */
export interface ScheduledItemInput {
  taskName: string;
  command: string;
  scheduledTime: string;
  recurrence?: string;
  tenantFilter?: string;
  parameters?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mailbox usage
// ---------------------------------------------------------------------------

/** Normalised size figures for a primary mailbox or an online archive. */
export interface MailboxSizeReport {
  /** Bytes consumed. Absent when the source reported no usable figure. */
  bytes?: number;
  /** `bytes` rendered for humans, e.g. `"12.30 GB"`. */
  size?: string;
  itemCount?: number;
  quotaBytes?: number;
  quota?: string;
  /** Percentage of the quota consumed. Absent when the quota is unknown or unlimited. */
  percentOfQuota?: number;
}

/** A mailbox's online archive, which may not exist at all. */
export interface ArchiveSizeReport extends MailboxSizeReport {
  enabled: boolean;
  autoExpanding?: boolean;
  autoExpandingScope?: string;
}

/** Per-mailbox usage as returned by the usage tools. */
export interface MailboxUsageRow {
  userPrincipalName?: string;
  displayName?: string;
  recipientTypeDetails?: string;
  /** Only present for an `AllTenants` query. */
  tenant?: string;
  mailbox: MailboxSizeReport;
  archive: ArchiveSizeReport;
}

/** Orderings `listMailboxUsage` can sort by, largest first. */
const MAILBOX_USAGE_SORTS = ['mailboxSize', 'archiveSize', 'totalSize', 'percentOfQuota'] as const;
export type MailboxUsageSort = (typeof MAILBOX_USAGE_SORTS)[number];

/** Tenant-wide totals accompanying a {@link MailboxUsageListing}. */
export interface MailboxUsageSummary {
  mailboxCount: number;
  archivesEnabled: number;
  mailboxBytes: number;
  mailboxSize?: string;
  archiveBytes: number;
  archiveSize?: string;
  totalBytes: number;
  totalSize?: string;
  /** Mailboxes at or above `nearQuotaPercent` of their primary quota. */
  nearQuotaCount: number;
  /** The threshold `nearQuotaCount` was counted against. */
  nearQuotaPercent: number;
}

/** What {@link CippService.getMailboxUsage} returns. */
export interface MailboxUsageReport {
  tenantFilter: string;
  source: 'live';
  userPrincipalName: string;
  displayName?: string;
  recipientTypeDetails?: string;
  mailbox: MailboxSizeReport;
  archive: ArchiveSizeReport;
}

/** What {@link CippService.listMailboxUsage} returns. */
export interface MailboxUsageListing {
  tenantFilter: string;
  source: 'reportDatabase';
  /** Timestamp of the newest cached row, so a caller can judge staleness. */
  cachedAt?: string;
  summary: MailboxUsageSummary;
  warnings?: string[];
  sortedBy: MailboxUsageSort;
  minSizeGB?: number;
  totalMatching: number;
  returned: number;
  mailboxes: MailboxUsageRow[];
}

/** Default page size for `listMailboxUsage`. A whole-tenant dump blows the tool-result limit. */
const MAILBOX_USAGE_DEFAULT_LIMIT = 50;
const MAILBOX_USAGE_MAX_LIMIT = 1000;

/**
 * Message `Get-CIPPMailboxesReport` throws when the reporting database has
 * never been synced for the tenant. `Invoke-ListMailboxes` serves it as the
 * body of an HTTP 500, so it reaches us inside the generic request error.
 */
const REPORT_DB_UNSYNCED_RE = /No mailbox data found in reporting database/i;

/**
 * A UPN replaced by a 32-character hex hash. Microsoft 365 substitutes these
 * throughout the usage reports when "conceal user, group, and site names" is
 * enabled in the admin centre, which also breaks CIPP's join between the
 * report and the mailbox list — see {@link summariseMailboxUsage}.
 */
const CONCEALED_NAME_RE = /^[0-9A-F]{32}$/i;

/** Percent-of-quota at which a mailbox is worth flagging in the summary. */
const NEAR_QUOTA_PERCENT = 90;

/** Build the normalised size block shared by primary mailboxes and archives. */
function sizeReport(
  bytes: number | undefined,
  quotaBytes: number | undefined,
  itemCount: number | undefined
): MailboxSizeReport {
  // A quota of 0 is the reporting database's "no quota data" default, not a
  // real limit of nothing — treating it as one would put every mailbox
  // infinitely over its quota.
  const quota = quotaBytes !== undefined && quotaBytes > 0 ? quotaBytes : undefined;
  return {
    bytes,
    size: formatBytes(bytes),
    itemCount,
    quotaBytes: quota,
    quota: formatBytes(quota),
    percentOfQuota: percentOfQuota(bytes, quota),
  };
}

/** Read a string field, treating blanks as absent. */
function stringField(value: unknown): string | undefined {
  return nonEmpty(value) ? value : undefined;
}

/**
 * Assemble a mailbox's archive block.
 *
 * Sizes are emitted only when the archive actually exists. Both sources
 * default an absent archive's figures to `0`, and passing that through would
 * read as "archive present but empty" — a different fact from "no archive".
 */
function archiveReport(
  enabled: boolean,
  bytes: number | undefined,
  quotaBytes: number | undefined,
  itemCount: number | undefined,
  autoExpanding: unknown,
  autoExpandingScope?: unknown
): ArchiveSizeReport {
  return {
    enabled,
    // Load-bearing: both sources default an absent archive's figures to 0, so
    // calling sizeReport unconditionally would emit a measured "0 B".
    ...(enabled ? sizeReport(bytes, quotaBytes, itemCount) : {}),
    ...(typeof autoExpanding === 'boolean' && { autoExpanding }),
    autoExpandingScope: stringField(autoExpandingScope),
  };
}

/**
 * Normalise one reporting-database mailbox row.
 *
 * `Set-CIPPDBCacheMailboxes` writes every size as an int64 byte count and
 * defaults each one to `0`, so a zero here means "nothing was merged in" just
 * as often as it means "empty mailbox". That ambiguity is unresolvable per
 * row; {@link summariseMailboxUsage} catches the systemic case instead.
 */
function normaliseReportRow(row: Record<string, unknown>): MailboxUsageRow {
  const archiveEnabled = row.ArchiveEnabled === true;
  const upn = stringField(row.UPN);
  const displayName = stringField(row.displayName);
  const recipientTypeDetails = stringField(row.recipientTypeDetails);
  const tenant = stringField(row.Tenant);

  return {
    userPrincipalName: upn,
    displayName,
    recipientTypeDetails,
    tenant,
    mailbox: sizeReport(
      toBytes(row.storageUsedInBytes),
      toBytes(row.prohibitSendReceiveQuotaInBytes),
      toFiniteNumber(row.MailboxItemCount)
    ),
    archive: archiveReport(
      archiveEnabled,
      toBytes(row.ArchiveSize),
      toBytes(row.ArchiveQuota),
      toFiniteNumber(row.ArchiveItemCount),
      row.AutoExpandingArchive
    ),
  };
}

/** Total bytes a mailbox occupies across its primary store and its archive. */
function totalMailboxBytes(row: MailboxUsageRow): number {
  return (row.mailbox.bytes ?? 0) + (row.archive.bytes ?? 0);
}

/** The figure a given sort orders on; `undefined` sorts last. */
function sortValue(row: MailboxUsageRow, sortBy: MailboxUsageSort): number | undefined {
  switch (sortBy) {
    case 'mailboxSize':
      return row.mailbox.bytes;
    case 'archiveSize':
      return row.archive.bytes;
    case 'totalSize':
      return totalMailboxBytes(row);
    case 'percentOfQuota':
      return row.mailbox.percentOfQuota;
  }
}

/**
 * Tenant-wide totals plus the warnings a caller needs to read them honestly.
 *
 * The concealment check is the important one. With "conceal user, group, and
 * site names" enabled in the M365 admin centre, Graph's usage reports return
 * 32-character hex hashes in place of UPNs. `Set-CIPPDBCacheMailboxes` joins
 * the report to the mailbox list *on the UPN*, so the join matches nothing and
 * every mailbox keeps its `0` default — a tenant that reads as empty rather
 * than one that failed. Returning that silently would be worse than returning
 * nothing at all.
 */
function summariseMailboxUsage(rows: MailboxUsageRow[]): {
  summary: MailboxUsageSummary;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (rows.length > 0 && rows.every((r) => (r.mailbox.bytes ?? 0) === 0)) {
    warnings.push(
      'Every mailbox reports 0 bytes used. That is the signature of a failed usage merge, ' +
        'not an empty tenant: it happens when "conceal user, group, and site names" is enabled ' +
        'for reports in the Microsoft 365 admin centre, or when the CIPP report cache was ' +
        'synced before usage data was available. Re-sync the cache with concealment off, or ' +
        'use cipp_get_mailbox_usage, which reads one mailbox live and is unaffected.'
    );
  }
  if (rows.some((r) => r.userPrincipalName && CONCEALED_NAME_RE.test(r.userPrincipalName))) {
    warnings.push(
      'Some mailboxes are identified by a 32-character hash instead of a UPN, so this tenant ' +
        'conceals names in its Microsoft 365 usage reports. Sizes on those rows cannot be ' +
        'attributed back to a person.'
    );
  }

  const mailboxBytes = rows.reduce((sum, r) => sum + (r.mailbox.bytes ?? 0), 0);
  const archiveBytes = rows.reduce((sum, r) => sum + (r.archive.bytes ?? 0), 0);

  return {
    summary: {
      mailboxCount: rows.length,
      archivesEnabled: rows.filter((r) => r.archive.enabled).length,
      mailboxBytes,
      mailboxSize: formatBytes(mailboxBytes),
      archiveBytes,
      archiveSize: formatBytes(archiveBytes),
      totalBytes: mailboxBytes + archiveBytes,
      totalSize: formatBytes(mailboxBytes + archiveBytes),
      nearQuotaCount: rows.filter(
        (r) => (r.mailbox.percentOfQuota ?? 0) >= NEAR_QUOTA_PERCENT
      ).length,
      nearQuotaPercent: NEAR_QUOTA_PERCENT,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * HTTP client for the CIPP Azure Function App API.
 *
 * All public methods map one-to-one to CIPP Azure Function endpoints.
 * Authentication is handled transparently using the Bearer token supplied
 * at construction time.
 *
 * @example
 * ```ts
 * const svc = new CippService(config, logger);
 * const tenants = await svc.listTenants();
 * ```
 */
export class CippService {
  private readonly baseUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly tokenProvider: TokenProvider | undefined;
  private readonly logger: Logger;

  constructor(config: CippServiceConfig, logger: Logger) {
    const { baseUrl, apiKey, tenantId, clientId, clientSecret, tokenScope, tokenUrl } = config.cipp;
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : undefined;
    this.apiKey = apiKey;
    this.logger = logger;

    // If a static apiKey was supplied, prefer it (backwards-compatible behaviour).
    // Otherwise, if OAuth client-credentials fields are present, build a token
    // provider that will mint CIPP access tokens on demand.
    if (!apiKey && tenantId && clientId && clientSecret) {
      this.tokenProvider = new TokenProvider(
        {
          tenantId,
          clientId,
          clientSecret,
          ...(tokenScope !== undefined ? { scope: tokenScope } : {}),
          ...(tokenUrl !== undefined ? { tokenUrl } : {}),
        },
        logger
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Send an HTTP request to the CIPP API.
   *
   * For GET requests, `params` are serialised as query-string parameters.
   * For all other methods, `body` is serialised as JSON.
   *
   * @param method  - HTTP verb.
   * @param path    - CIPP Function name / path segment appended to `/api/`.
   * @param params  - Optional query parameters (GET) or ignored for non-GET.
   * @param body    - Optional request body (non-GET requests).
   * @returns Parsed JSON response typed as `T`.
   * @throws {McpError} On HTTP errors or network failures.
   */
  private async request<T>(
    method: HttpMethod,
    path: string,
    params?: Record<string, unknown>,
    body?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new McpError(ErrorCode.InvalidParams, 'CIPP_BASE_URL is not configured. Set it in your environment or MCP client config.');
    }
    if (!this.apiKey && !this.tokenProvider) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'CIPP authentication is not configured. Set CIPP_API_KEY, or set CIPP_TENANT_ID + CIPP_CLIENT_ID + CIPP_CLIENT_SECRET for OAuth client-credentials auth.'
      );
    }

    const bearer = this.apiKey ?? (await this.tokenProvider!.getAccessToken());

    const url = new URL(`${this.baseUrl}/api/${path}`);

    if (method === 'GET' && params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    };

    const requestInit: RequestInit = {
      method,
      headers,
    };

    if (method !== 'GET' && body !== undefined) {
      requestInit.body = JSON.stringify(body);
    }

    if (timeoutMs !== undefined) {
      // Aborts the fetch if the response is not received in time. The abort
      // surfaces as a network error below, which callers can catch per request.
      requestInit.signal = AbortSignal.timeout(timeoutMs);
    }

    this.logger.debug('CIPP API request', { method, url: url.toString() });

    let response: Response;
    try {
      response = await fetch(url.toString(), requestInit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('CIPP API network error', { method, url: url.toString(), error: message });
      throw new McpError(
        ErrorCode.InternalError,
        `Network error communicating with CIPP API (${method} ${url.toString()}): ${message}`
      );
    }

    if (!response.ok) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        // ignore read errors; we already have the status code
      }
      this.logger.error('CIPP API HTTP error', {
        method,
        url: url.toString(),
        status: response.status,
        body: responseBody,
      });
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP API returned HTTP ${response.status} for ${method} ${url.toString()}: ${responseBody}`
      );
    }

    const text = await response.text();
    if (text.trim() === '') {
      // Some CIPP endpoints legitimately return HTTP 200 with an empty body.
      // Treat that as "no content" rather than crashing on a JSON parse error.
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to parse CIPP API response as JSON (${method} ${url.toString()}): ${message}`
      );
    }
  }

  /**
   * Run a mutating CIPP call and report what actually happened, as a
   * {@link VerifiedWrite}.
   *
   * CIPP's acknowledgement is not proof. Two behaviours make a bare HTTP 200
   * unsafe to relay as success:
   *   1. Several entrypoints hardcode 200 and report the failure only as a
   *      string inside `Results` (the `Set-CIPPUser` trap).
   *   2. Several return the moment the job is ACCEPTED, before the change
   *      exists in Microsoft.
   *
   * So this helper parses `Results` for CIPP's own failure vocabulary first —
   * a reported failure is `failed`, and there is nothing to wait for — and
   * otherwise polls a Microsoft-side readback until it confirms the change or
   * the budget runs out. A readback that throws counts as "not yet": a failed
   * READ is not a failed WRITE, so we keep polling and, at the deadline,
   * return `pending` with a recheck instruction rather than a false success.
   *
   * @param run        Executes the write. Its response becomes `submission`.
   * @param readback   Returns true once Microsoft reflects the change. Omit ONLY
   *                   when CIPP performs the change inline (returning HTTP 500 on
   *                   failure, which {@link request} throws on) and no CIPP read
   *                   exposes the changed field — then reaching a non-failing
   *                   `Results` IS the confirmation, and an empty `Results`,
   *                   which proves nothing, stays `pending`.
   * @param verifiedBy The field or read that proves the change.
   * @param confirmed  Message to use once confirmed.
   * @param recheck    How to confirm by hand when it is not.
   */
  private async verifyWrite(opts: {
    run: () => Promise<{ Results?: unknown } | undefined>;
    readback?: () => Promise<boolean>;
    verifiedBy: string;
    confirmed: string;
    recheck: string;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<VerifiedWrite> {
    const submission = await opts.run();
    const { results, failures } = interpretResults(submission?.Results);

    const envelope = (status: WriteStatus): VerifiedWrite => ({
      status,
      verifiedBy: opts.verifiedBy,
      message:
        status === 'confirmed'
          ? opts.confirmed
          : `${opts.recheck} Do NOT report this to the caller as done.`,
      recheck: status === 'confirmed' ? null : opts.recheck,
      failures,
      submission,
    });

    if (failures.length > 0) {
      return envelope('failed');
    }

    if (!opts.readback) {
      // CIPP ran the change inline and did not report a failure. An empty
      // `Results` is inconclusive, so it does not earn a confirmation.
      return envelope(results.length > 0 ? 'confirmed' : 'pending');
    }

    const intervalMs = opts.intervalMs ?? WRITE_VERIFY_INTERVAL_MS;
    const deadline = Date.now() + (opts.timeoutMs ?? WRITE_VERIFY_TIMEOUT_MS);

    // Always read back at least once, then poll until the deadline.
    for (;;) {
      let confirmed = false;
      try {
        confirmed = await opts.readback();
      } catch {
        // A failed READ is not a failed WRITE. Stay unconfirmed and keep polling.
      }
      if (confirmed) return envelope('confirmed');
      if (Date.now() >= deadline) return envelope('pending');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // -------------------------------------------------------------------------
  // Core
  // -------------------------------------------------------------------------

  /**
   * Ping the CIPP API to verify connectivity and authentication.
   * Calls the `PublicPing` Azure Function.
   */
  async ping<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'PublicPing');
  }

  /**
   * Retrieve the current CIPP server version.
   * Calls the `GetVersion` Azure Function.
   */
  async getVersion<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'GetVersion');
  }

  /**
   * List CIPP server logs, optionally filtered by date.
   * Calls the `ListLogs` Azure Function.
   *
   * @param params - Optional filter parameters.
   * @param params.DateFilter - ISO 8601 date string to filter log entries.
   */
  async listLogs<T = unknown>(params?: { DateFilter?: string }): Promise<T> {
    return this.request<T>('GET', 'ListLogs', params as Record<string, unknown>);
  }

  // -------------------------------------------------------------------------
  // Tenants
  // -------------------------------------------------------------------------

  /**
   * List all managed tenants known to CIPP.
   * Calls the `ListTenants` Azure Function.
   *
   * @param params - Optional listing options.
   * @param params.allTenants - When `true`, returns all tenants including inactive ones.
   */
  async listTenants<T = unknown>(params?: { allTenants?: boolean }): Promise<T> {
    return this.request<T>('POST', 'ListTenants', undefined, {
      allTenantSelector: params?.allTenants,
    });
  }

  /**
   * Retrieve detailed information for a single tenant.
   * Calls the `ListTenantDetails` Azure Function.
   *
   * @param tenantFilter - The tenant's default domain name or identifier.
   */
  async getTenantDetails<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListTenantDetails', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * List users within a tenant, with optional search filtering.
   * Calls the `ListUsers` Azure Function.
   *
   * `Invoke-ListUsers` reads only `tenantFilter`, `UserID` and `graphFilter`
   * from the query string — it has never read `searchField` / `searchValue`.
   * Passing those through returned the entire tenant while appearing to
   * filter, so search is translated into a Graph `$filter` instead.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param params       - Optional search parameters.
   * @param params.searchField - Azure AD attribute to search on (e.g. `displayName`).
   * @param params.searchValue - Value to match against the search field.
   */
  async listUsers<T = unknown>(
    tenantFilter: string,
    params?: { searchField?: string; searchValue?: string }
  ): Promise<T> {
    const field = params?.searchField;
    const value = params?.searchValue;

    if ((field === undefined) !== (value === undefined)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'searchField and searchValue must be supplied together. Supplying one alone would silently return every user in the tenant.'
      );
    }

    const query: Record<string, unknown> = { tenantFilter };
    if (field && value) {
      const escaped = value.replace(/'/g, "''");
      // Exact match on the identity fields — a partial UPN or address is
      // rarely what a caller means. displayName keeps prefix matching.
      // Upstream issues the request with -ComplexFilter (ConsistencyLevel:
      // eventual), so startsWith is supported.
      query.graphFilter =
        field === 'displayName'
          ? `startsWith(${field}, '${escaped}')`
          : `${field} eq '${escaped}'`;
    }

    return this.request<T>('GET', 'ListUsers', query);
  }

  /**
   * Create a new user in a tenant.
   * Calls the `AddUser` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userData     - User properties to set (displayName, UPN, password, etc.).
   */
  async createUser(
    tenantFilter: string,
    userData: Record<string, unknown>
  ): Promise<VerifiedWrite> {
    // `New-CippUser` builds the UPN as "<username>@<Domain>" and never reads a
    // whole `userPrincipalName`. Passing one through leaves both halves empty,
    // so CIPP posts "@" to Graph and fails on the domain portion.
    const upn = typeof userData.userPrincipalName === 'string' ? userData.userPrincipalName : '';
    const at = upn.lastIndexOf('@');
    if (at <= 0 || at === upn.length - 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `userPrincipalName must be a full UPN (e.g. alice@contoso.com); got "${upn}". CIPP builds the UPN from separate username and Domain fields and cannot recover them from a partial value.`
      );
    }
    const { userPrincipalName: _upn, ...rest } = userData;

    return this.verifyWrite({
      run: () =>
        this.request('POST', 'AddUser', undefined, {
          tenantFilter,
          username: upn.slice(0, at),
          Domain: upn.slice(at + 1),
          ...rest,
        }),
      verifiedBy: 'userPrincipalName present in ListUsers',
      readback: async () => {
        const users = await this.listUsers<Array<{ userPrincipalName?: string }>>(tenantFilter, {
          searchField: 'userPrincipalName',
          searchValue: upn,
        });
        return (Array.isArray(users) ? users : []).some(
          (u) => u?.userPrincipalName?.toLowerCase() === upn.toLowerCase()
        );
      },
      confirmed: `User ${upn} confirmed present in ${tenantFilter}. Note that CIPP applies licences, group adds and mailbox grants after creation and reports their failures as strings in submission.Results — check those before calling the account fully provisioned.`,
      recheck: `CIPP accepted AddUser for ${upn}, but the account was not visible in ${tenantFilter} within the verification window. Re-check with cipp_list_users before telling anyone the account exists.`,
    });
  }

  /**
   * Resolve a user's full identity (object id + current UPN halves) from a
   * UPN or object id. Required by {@link editUser}: CIPP's `Invoke-EditUser`
   * REBUILDS the account's userPrincipalName on every call from the body's
   * `username` + `Domain` fields — it never reads a `userPrincipalName`
   * field. Editing without the current identity halves does not fail safe;
   * it renames the account (or 500s with "The domain portion of the
   * userPrincipalName property is invalid").
   *
   * Uses ListUsers' `UserID` / `graphFilter` params (the only two
   * Invoke-ListUsers actually reads) so this costs one narrow lookup, not a
   * tenant dump.
   */
  private async resolveUserIdentity(
    tenantFilter: string,
    upnOrId: string,
    reason: string
  ): Promise<{ id: string; userPrincipalName: string; username: string; domain: string }> {
    const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const byId = GUID_RE.test(upnOrId);

    const rows = await this.request<Array<Record<string, unknown>>>('GET', 'ListUsers', {
      tenantFilter,
      ...(byId
        ? { UserID: upnOrId }
        : { graphFilter: `userPrincipalName eq '${upnOrId.replace(/'/g, "''")}'` }),
    });

    const list = Array.isArray(rows) ? rows : [];
    const match = byId
      ? list[0]
      : list.find(
          (u) =>
            typeof u.userPrincipalName === 'string' &&
            u.userPrincipalName.toLowerCase() === upnOrId.toLowerCase()
        );

    const upn = typeof match?.userPrincipalName === 'string' ? match.userPrincipalName : undefined;
    const id = typeof match?.id === 'string' ? match.id : undefined;

    if (!upn || !id || !upn.includes('@')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Could not resolve user "${upnOrId}" to a current UPN in tenant ${tenantFilter}. ${reason}`
      );
    }

    const at = upn.lastIndexOf('@');
    return { id, userPrincipalName: upn, username: upn.slice(0, at), domain: upn.slice(at + 1) };
  }

  /**
   * Read one user back by object id, for verifying a write.
   *
   * The `UserID` path is the one that matters: `Invoke-ListUsers` applies its
   * explicit `$select` there, which is what returns `accountEnabled` and
   * `lastPasswordChangeDateTime`. A `graphFilter` query returns Graph's default
   * property set, which omits both — so a UPN-based readback silently cannot
   * see the fields that prove a disable or a password reset landed.
   */
  private async readUserById<T = Record<string, unknown>>(
    tenantFilter: string,
    id: string
  ): Promise<T | undefined> {
    const rows = await this.request<Array<Record<string, unknown>>>('GET', 'ListUsers', {
      tenantFilter,
      UserID: id,
    });
    return (Array.isArray(rows) ? (rows[0] as T | undefined) : undefined) ?? undefined;
  }

  /**
   * Update properties of an existing user, and optionally its licenses.
   * Calls the `EditUser` Azure Function.
   *
   * @param tenantFilter   - Tenant domain or identifier.
   * @param userId         - Object id or UPN of the user to update.
   * @param userData       - User properties to update.
   * @param licenseOptions - Optional license add/replace/remove. Upstream
   *                         reads licenses as `[{ value: skuId }]` objects
   *                         plus a `removeLicenses` boolean (Invoke-EditUser
   *                         line 25 / 104–144).
   */
  async editUser<T = unknown>(
    tenantFilter: string,
    userId: string,
    userData: Record<string, unknown>,
    licenseOptions?: { licenses?: string[]; removeLicenses?: boolean }
  ): Promise<T> {
    const identity = await this.resolveUserIdentity(
      tenantFilter,
      userId,
      'Refusing to edit: CIPP rebuilds and re-writes userPrincipalName on every EditUser call, so editing without the account\'s current UPN would rename it.'
    );

    const body: Record<string, unknown> = {
      tenantFilter,
      id: identity.id,
      username: identity.username,
      Domain: identity.domain,
      ...userData,
    };

    if (licenseOptions?.licenses && licenseOptions.licenses.length > 0) {
      if (licenseOptions.removeLicenses === true) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'licenses and removeLicenses=true are mutually exclusive. removeLicenses strips every assigned SKU and ignores the licenses list.'
        );
      }
      body.licenses = licenseOptions.licenses.map((skuId) => ({ value: skuId }));
      body.removeLicenses = false;
    } else if (licenseOptions?.removeLicenses !== undefined) {
      body.removeLicenses = licenseOptions.removeLicenses;
    }

    const response = await this.request<{ Results?: unknown }>('PATCH', 'EditUser', undefined, body);

    // Set-CIPPUser swallows its own exceptions and reports them as strings in
    // Results, so EditUser returns HTTP 200 on failure. Parse, never assume.
    const { results, failures } = interpretResults(response?.Results);

    return {
      status: failures.length > 0 ? 'failed' : 'edited',
      userPrincipalName: identity.userPrincipalName,
      results,
      failures,
      message:
        failures.length > 0
          ? `CIPP returned HTTP 200 but reported failures editing ${identity.userPrincipalName}. Do NOT report success to the caller: ${failures.join(' | ')}`
          : `User ${identity.userPrincipalName} edited in ${tenantFilter}.`,
    } as T;
  }

  /**
   * Disable a user account, preventing sign-in.
   * Calls the `ExecDisableUser` Azure Function, then confirms by readback.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Object id or UPN of the user to disable.
   */
  async disableUser(tenantFilter: string, userId: string): Promise<VerifiedWrite> {
    // Resolve first: the readback needs an object id, because `accountEnabled`
    // only comes back on ListUsers' by-id path (see readUserById).
    const { id, userPrincipalName } = await this.resolveUserIdentity(
      tenantFilter,
      userId,
      'Refusing to disable: without the account\'s object id the result cannot be read back, and CIPP\'s acknowledgement alone does not prove the account was disabled.'
    );

    return this.verifyWrite({
      // `Enable` is coerced with [Convert]::ToBoolean, which turns an absent
      // value into $false. Relying on that is a coin-flip on CIPP never adding
      // a default; send the intent explicitly.
      run: () =>
        this.request('POST', 'ExecDisableUser', undefined, {
          tenantFilter,
          ID: id,
          Enable: false,
        }),
      verifiedBy: 'accountEnabled',
      readback: async () => {
        const user = await this.readUserById<{ accountEnabled?: boolean }>(tenantFilter, id);
        return user?.accountEnabled === false;
      },
      confirmed: `Sign-in disabled for ${userPrincipalName} in ${tenantFilter} — confirmed by readback (accountEnabled=false).`,
      recheck: `CIPP accepted ExecDisableUser for ${userPrincipalName}, but accountEnabled was not observed false within the verification window. Re-read the account with cipp_list_users before telling anyone it is disabled.`,
    });
  }

  /**
   * Reset a user's password to one CIPP generates, and confirm by readback.
   *
   * CIPP always generates the password itself (`New-passwordString`) and
   * returns it in the response. `Invoke-ExecResetPass` reads only
   * `tenantFilter`, `ID`, `MustChange` and `displayName` — there is no input
   * field for a chosen password, so supplying one is rejected here rather than
   * silently dropped. Handing a caller a password the tenant never received is
   * the worst failure this tool could have.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Object id or UPN of the user.
   * @param options      - Optional behaviour flags.
   * @param options.mustChangeAtNextSignIn - Force a change at next sign-in.
   * @param options.newPassword - Not supported by CIPP; rejected if supplied.
   */
  async resetPassword(
    tenantFilter: string,
    userId: string,
    options?: { mustChangeAtNextSignIn?: boolean; newPassword?: string }
  ): Promise<VerifiedWrite> {
    if (options?.newPassword !== undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'CIPP does not accept a chosen password. Invoke-ExecResetPass generates one itself and ignores any password in the request body, so honouring this would report a password the tenant never set. Re-run without newPassword and read the generated password out of the response.'
      );
    }

    const { id, userPrincipalName } = await this.resolveUserIdentity(
      tenantFilter,
      userId,
      'Refusing to reset: without the account\'s object id the result cannot be read back, and CIPP\'s acknowledgement alone does not prove the password changed.'
    );

    // Capture the account's own prior timestamp and verify against an ADVANCE.
    // Comparing to "now" would depend on clock agreement between this process,
    // CIPP and Entra; comparing to the account's previous value does not.
    const before = await this.readUserById<{ lastPasswordChangeDateTime?: string }>(
      tenantFilter,
      id
    );
    const baseline = timestampOf(before?.lastPasswordChangeDateTime);

    return this.verifyWrite({
      run: () =>
        this.request('POST', 'ExecResetPass', undefined, {
          tenantFilter,
          ID: id,
          displayName: userPrincipalName,
          MustChange: options?.mustChangeAtNextSignIn === true,
        }),
      verifiedBy: 'lastPasswordChangeDateTime',
      readback: async () => {
        // No readable baseline means no advance can be proved. Staying
        // unconfirmed is the honest outcome; the recheck instruction covers it.
        if (baseline === undefined) return false;
        const after = await this.readUserById<{ lastPasswordChangeDateTime?: string }>(
          tenantFilter,
          id
        );
        const changed = timestampOf(after?.lastPasswordChangeDateTime);
        return changed !== undefined && changed > baseline;
      },
      confirmed: `Password reset for ${userPrincipalName} in ${tenantFilter} — confirmed by readback (lastPasswordChangeDateTime advanced). CIPP's generated password is in submission.Results.`,
      recheck: `CIPP accepted ExecResetPass for ${userPrincipalName}, but lastPasswordChangeDateTime was not observed to advance within the verification window. On a directory-synced account that is expected: CIPP submits the reset via password writeback, which applies asynchronously and fails outright if writeback is disabled or the on-premises policy rejects the password. Re-read the account with cipp_list_users before giving anyone the new password.`,
    });
  }

  /**
   * Reset all registered MFA methods for a user.
   * Calls the `ExecResetMFA` Azure Function.
   *
   * `Invoke-ExecResetMFA` passes the body's `ID` straight through as
   * `-UserPrincipalName`, so this endpoint wants a UPN. An object id is
   * resolved first rather than forwarded, which would fail on every
   * GUID-addressed call.
   *
   * No readback: the only CIPP read of MFA state is `ListMFAUsers`, a
   * tenant-wide cache-backed report, and a stale cache would produce a
   * confident wrong answer either way. `Remove-CIPPUserMFA` deletes each method
   * inline and throws — HTTP 500 — on any failure, including a partial one, so
   * its own result is the available evidence. {@link verifyWrite} parses that
   * result rather than assuming it.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Object id or UPN of the user.
   */
  async resetMFA(tenantFilter: string, userId: string): Promise<VerifiedWrite> {
    const { userPrincipalName } = await this.resolveUserIdentity(
      tenantFilter,
      userId,
      'Refusing to reset MFA: CIPP addresses the account by UPN on this endpoint, and forwarding an unresolved object id would target nothing.'
    );

    return this.verifyWrite({
      run: () =>
        this.request('POST', 'ExecResetMFA', undefined, {
          tenantFilter,
          ID: userPrincipalName,
        }),
      verifiedBy: 'ExecResetMFA result (Remove-CIPPUserMFA runs inline)',
      confirmed: `MFA methods reset for ${userPrincipalName} in ${tenantFilter} — CIPP completed the removal and reported no failure. The user must re-register at next sign-in.`,
      recheck: `CIPP did not report a clear success for ExecResetMFA on ${userPrincipalName}. Check the user's registered methods in the CIPP MFA report before telling anyone MFA was reset.`,
    });
  }

  /**
   * Revoke all active sign-in sessions for a user.
   * Calls the `ExecRevokeSessions` Azure Function.
   *
   * No readback: the field that records a revoke,
   * `signInSessionsValidFromDateTime`, is not in the property set any CIPP read
   * returns. `Invoke-ExecRevokeSessions` calls Graph's `revokeSignInSessions`
   * inline and returns HTTP 500 on failure, so its own result is the available
   * evidence — parsed, not assumed. Faking a readback here would be worse than
   * admitting there isn't one.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Object id or UPN of the user.
   */
  async revokeSessions(tenantFilter: string, userId: string): Promise<VerifiedWrite> {
    // CIPP builds its result string from `Username`; without it a successful
    // revoke reports "Successfully revoked sessions for " with a blank name,
    // which reads to a human (and to an agent) like a failure.
    const { id, userPrincipalName } = await this.resolveUserIdentity(
      tenantFilter,
      userId,
      'Refusing to revoke: CIPP names the account in its own result string from the Username field, and omitting it returns a blank confirmation that cannot be distinguished from a failure.'
    );

    return this.verifyWrite({
      // Lowercase `id` is the spelling `Invoke-ExecRevokeSessions` reads; the
      // sibling Exec endpoints read `ID`. PowerShell resolves either, but
      // matching upstream keeps this auditable against the function it calls.
      run: () =>
        this.request('POST', 'ExecRevokeSessions', undefined, {
          tenantFilter,
          id,
          Username: userPrincipalName,
        }),
      verifiedBy: 'ExecRevokeSessions result (Graph revokeSignInSessions runs inline)',
      confirmed: `Sign-in sessions revoked for ${userPrincipalName} in ${tenantFilter} — CIPP completed the revoke and reported no failure.`,
      recheck: `CIPP did not report a clear success for ExecRevokeSessions on ${userPrincipalName}. Re-run the revoke before telling anyone the sessions are gone.`,
    });
  }

  /**
   * Offboard a user by queueing CIPP's offboarding job.
   * Calls the `ExecOffboardUser` Azure Function.
   *
   * `Invoke-ExecOffboardUser` reads `$Request.Body.user.value` and hands every
   * remaining body property to `Invoke-CIPPOffboardingJob` as its options
   * object, so both the user list and the action names have to match CIPP
   * exactly. The previous payload (`ID` plus four invented option names)
   * matched nothing: newer CIPP rejects it with a 400, older CIPP returns
   * HTTP 200 having queued a job that runs no actions at all.
   *
   * The result reports `queued`, never `offboarded` — CIPP returns success on
   * task *creation* and never waits for the job to finish.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Object id or UPN of the user to offboard.
   * @param options      - Offboarding actions, keyed by CIPP's own action names.
   */
  async offboardUser<T = unknown>(
    tenantFilter: string,
    userId: string,
    options?: Record<string, unknown>
  ): Promise<T> {
    // The offboarding tasks anchor Exchange and MFA operations on the UPN, so
    // resolve an object id to the account's current UPN before queueing.
    const identity = await this.resolveUserIdentity(
      tenantFilter,
      userId,
      'Refusing to queue offboarding: the offboarding job anchors its Exchange and MFA operations on the account\'s current UPN.'
    );
    const opts = options ?? {};

    const body: Record<string, unknown> = {
      tenantFilter,
      // Read as `$Request.Body.user.value`. Older CIPP resolves nothing from
      // bare UPN strings, so always send the { value } shape.
      user: [{ value: identity.userPrincipalName }],
    };
    const actions: string[] = [];

    for (const action of OFFBOARD_BOOLEAN_ACTIONS) {
      if (opts[action] === true) {
        body[action] = true;
        actions.push(action);
      }
    }
    for (const action of OFFBOARD_COLLECTION_ACTIONS) {
      const value = opts[action];
      if (Array.isArray(value) && value.length > 0) {
        body[action] = value;
        actions.push(action);
      }
    }
    if (nonEmpty(opts.forward)) {
      // Read as `$Options.forward.value` — a bare string forwards to nothing.
      body.forward = { value: opts.forward.trim() };
      body.KeepCopy = opts.KeepCopy === true;
      actions.push('forward');
    }
    if (nonEmpty(opts.OOO)) {
      body.OOO = opts.OOO;
      actions.push('OOO');
    }

    if (actions.length === 0) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'No offboarding actions were selected. CIPP queues the job and returns HTTP 200 either way, so an empty action set reports success while doing nothing. Enable at least one action (e.g. RemoveLicenses, DisableSignIn, RevokeSessions).'
      );
    }

    const response = await this.request<{ Results?: unknown }>(
      'POST',
      'ExecOffboardUser',
      undefined,
      body
    );
    const { results, failures } = interpretResults(response?.Results);

    return {
      status: failures.length > 0 ? 'failed' : 'queued',
      userPrincipalName: identity.userPrincipalName,
      actions,
      results,
      failures,
      message:
        failures.length > 0
          ? `CIPP returned HTTP 200 but reported failures queueing offboarding for ${identity.userPrincipalName}. Do NOT report success to the caller: ${failures.join(' | ')}`
          : `Offboarding QUEUED for ${identity.userPrincipalName} in ${tenantFilter} with ${actions.length} action(s): ${actions.join(', ')}. CIPP reports success on task creation, not completion — confirm the outcome in CIPP's Offboarding view before telling the caller the account is offboarded.`,
    } as T;
  }

  /**
   * List devices registered to a specific user.
   * Calls the `ListUserDevices` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user.
   */
  async listUserDevices<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserDevices', { tenantFilter, userId });
  }

  /**
   * List group memberships for a specific user.
   * Calls the `ListUserGroups` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user.
   */
  async listUserGroups<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ListUserGroups', { tenantFilter, userId });
  }

  /**
   * Run a Business Email Compromise (BEC) check for a user.
   * Calls the `ExecBECCheck` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user to check.
   */
  async becCheck<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('GET', 'ExecBECCheck', { tenantFilter, userId });
  }

  /**
   * List MFA registration status for all users in a tenant.
   * Calls the `ListMFAUsers` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listMfaUsers<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListMFAUsers', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  /**
   * List Azure AD groups in a tenant, with optional search filtering.
   * Calls the `ListGroups` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param params       - Optional search parameters.
   * @param params.search - Free-text search string to filter groups.
   */
  async listGroups<T = unknown>(
    tenantFilter: string,
    params?: { search?: string }
  ): Promise<T> {
    return this.request<T>('GET', 'ListGroups', { tenantFilter, ...params });
  }

  /**
   * Create a new group in a tenant.
   * Calls the `AddGroup` Azure Function.
   *
   * CIPP derives `securityEnabled`, `mailEnabled` and `mailNickname` from
   * `groupType` and reads none of them from the request, so Graph-shaped
   * booleans are silently discarded. `groupType` itself is mandatory:
   * `New-CIPPGroup` opens with `$GroupObject.groupType.ToLower()`, which throws
   * on a null and surfaces as an opaque HTTP 500.
   *
   * Note CIPP's vocabulary: a plain Entra security group is `Generic`.
   * `Security` means a mail-enabled security group created through Exchange.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param groupData    - Group properties in CIPP's own shape.
   */
  async createGroup<T = unknown>(
    tenantFilter: string,
    groupData: {
      displayName: string;
      groupType: CippGroupType;
      description?: string;
      username?: string;
      primDomain?: string;
    }
  ): Promise<T> {
    if (!CIPP_GROUP_TYPES.includes(groupData.groupType)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `groupType must be one of ${CIPP_GROUP_TYPES.join(', ')}; got "${groupData.groupType}". CIPP calls groupType.ToLower() unconditionally and returns an opaque HTTP 500 without it.`
      );
    }
    if (MAIL_ENABLED_GROUP_TYPES.includes(groupData.groupType) && !groupData.username) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `groupType "${groupData.groupType}" is mail-enabled, so CIPP needs "username" — the local part of the group's address — to build it.`
      );
    }

    const body: Record<string, unknown> = {
      tenantFilter,
      displayName: groupData.displayName,
      groupType: groupData.groupType,
    };
    if (groupData.description !== undefined) body.description = groupData.description;
    if (groupData.username !== undefined) body.username = groupData.username;
    // Read as `$GroupObject.primDomain.value`, not as a bare string.
    if (groupData.primDomain !== undefined) body.primDomain = { value: groupData.primDomain };

    return this.request<T>('POST', 'AddGroup', undefined, body);
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  /**
   * List Exchange Online mailboxes in a tenant.
   * Calls the `ListMailboxes` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param params       - Optional filtering options.
   * @param params.type  - Mailbox type filter (e.g. `"SharedMailbox"`, `"UserMailbox"`).
   */
  async listMailboxes<T = unknown>(
    tenantFilter: string,
    params?: { type?: string }
  ): Promise<T> {
    return this.request<T>('GET', 'ListMailboxes', { tenantFilter, ...params });
  }

  /**
   * List permissions granted on a specific mailbox.
   * Calls the `ListmailboxPermissions` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param upn          - User principal name / primary SMTP address of the mailbox.
   */
  async listMailboxPermissions<T = unknown>(tenantFilter: string, upn: string): Promise<T> {
    return this.request<T>('GET', 'ListmailboxPermissions', {
      tenantFilter,
      UserPrincipalName: upn,
    });
  }

  /**
   * Report primary-mailbox and online-archive sizes for one mailbox.
   * Calls the `ListUserMailboxDetails` Azure Function.
   *
   * Reads live rather than from CIPP's reporting database, which makes it the
   * reliable option in two situations the tenant-wide tool cannot cover: a
   * tenant whose report cache has never been synced, and a tenant that
   * conceals names in its Microsoft 365 usage reports. `Invoke-ListUser-
   * MailboxDetails` takes the primary size straight from the Exchange admin
   * API (`Mailbox('<id>')/Exchange.GetMailboxStatistics()`), never from the
   * Graph usage reports, so concealment cannot blank it.
   *
   * Upstream returns every size as a gigabyte figure rounded to two decimals,
   * so the byte counts here are accurate to roughly 10 MB. Quotas are the
   * exception: they are recovered exactly from the raw `Get-Mailbox` object
   * that CIPP includes in the response, whose Exchange-formatted string
   * carries the true byte count.
   *
   * @param tenantFilter - Tenant domain or GUID. `allTenants` is not supported.
   * @param upnOrId      - UPN or Entra object id of the mailbox owner.
   */
  async getMailboxUsage(
    tenantFilter: string,
    upnOrId: string
  ): Promise<MailboxUsageReport> {
    // `Invoke-ListUserMailboxDetails` reads a single tenant; it has no
    // all-tenants branch. Left to run, the call would first fan `ListUsers`
    // out across every managed tenant and then ask for one mailbox against a
    // tenantFilter upstream cannot resolve — slow, and wrong in a way that
    // reads like a CIPP fault. Reject it here, as the other tools do.
    if (tenantFilter.trim().toLowerCase() === 'alltenants') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'cipp_get_mailbox_usage reads one mailbox in one tenant; allTenants is not supported. ' +
          "Name the mailbox's own tenant, or use cipp_list_mailbox_usage, which does support " +
          'AllTenants.'
      );
    }

    // The endpoint keys off the Entra object id — a UPN in `UserID` returns an
    // empty shell rather than an error, so resolve before asking.
    const identity = await this.resolveUserIdentity(
      tenantFilter,
      upnOrId,
      'Mailbox usage is looked up by Entra object id, which could not be determined.'
    );

    const details = await this.request<Record<string, unknown>>(
      'GET',
      'ListUserMailboxDetails',
      {
        tenantFilter,
        UserID: identity.id,
        userMail: identity.userPrincipalName,
      }
    );

    const raw = (details ?? {}) as Record<string, unknown>;
    const mailboxObject = (raw.Mailbox ?? {}) as Record<string, unknown>;
    const archiveEnabled = raw.ArchiveMailBox === true;

    // The top-level quota has had its unit stripped upstream
    // (`[float]($ProhibitSendReceiveQuota -split ' ')[0]`), so a mailbox with a
    // quota Exchange prints in TB would read as a handful of GB. The raw
    // Get-Mailbox string still carries "(N bytes)", so prefer it and keep the
    // stripped figure only as a fallback.
    const quotaBytes =
      toBytes(mailboxObject.ProhibitSendReceiveQuota) ??
      fromGigabytes(raw.ProhibitSendReceiveQuota);

    return {
      tenantFilter,
      source: 'live',
      userPrincipalName: identity.userPrincipalName,
      displayName: stringField(mailboxObject.DisplayName),
      recipientTypeDetails: stringField(raw.RecipientTypeDetails),
      mailbox: sizeReport(
        fromGigabytes(raw.TotalItemSize),
        quotaBytes,
        toFiniteNumber(raw.ItemCount)
      ),
      archive: archiveReport(
        archiveEnabled,
        fromGigabytes(raw.TotalArchiveItemSize),
        toBytes(mailboxObject.ArchiveQuota),
        toFiniteNumber(raw.TotalArchiveItemCount),
        raw.AutoExpandingArchive,
        raw.AutoExpandingArchiveScope
      ),
    };
  }

  /**
   * Report primary-mailbox and online-archive sizes across a whole tenant.
   * Calls `ListMailboxes` with `UseReportDB=true`.
   *
   * Sizes exist *only* on that cached path: `Invoke-ListMailboxes`' live
   * Exchange query selects no size fields at all, so this is the one
   * tenant-wide source. The cache in turn merges Graph's
   * `getMailboxUsageDetail` report (primary size, item count, quota) with
   * bulk `Get-MailboxStatistics -Archive` calls (archive size and count).
   *
   * The full row set is fetched and totalled before `limit` is applied, so the
   * summary describes the whole tenant even when only the top mailboxes are
   * returned. Returning every row of a large tenant would exceed the client's
   * tool-result limit — the same failure `cipp_list_users` hit.
   *
   * @param tenantFilter    - Tenant domain or GUID, or `AllTenants`.
   * @param params.sortBy   - Ordering, largest first. Defaults to `mailboxSize`.
   * @param params.limit    - Rows to return. Defaults to 50, maximum 1000.
   * @param params.minSizeGB - Drop mailboxes whose primary and archive stores
   *                           together fall below this size.
   */
  async listMailboxUsage(
    tenantFilter: string,
    params: { sortBy?: string; limit?: number; minSizeGB?: number } = {}
  ): Promise<MailboxUsageListing> {
    const sortBy = (params.sortBy ?? 'mailboxSize') as MailboxUsageSort;
    if (!MAILBOX_USAGE_SORTS.includes(sortBy)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `sortBy must be one of ${MAILBOX_USAGE_SORTS.join(', ')}; got "${params.sortBy}".`
      );
    }

    const limit = params.limit ?? MAILBOX_USAGE_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAILBOX_USAGE_MAX_LIMIT) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `limit must be an integer between 1 and ${MAILBOX_USAGE_MAX_LIMIT}; got ${params.limit}.`
      );
    }

    const minSizeGB = params.minSizeGB;
    if (minSizeGB !== undefined && (!Number.isFinite(minSizeGB) || minSizeGB < 0)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `minSizeGB must be a non-negative number; got ${minSizeGB}.`
      );
    }

    let raw: unknown;
    try {
      raw = await this.request<unknown>('GET', 'ListMailboxes', {
        tenantFilter,
        UseReportDB: true,
      });
    } catch (err) {
      // CIPP serves the unsynced-cache case as an HTTP 500 whose body is the
      // bare message, which would otherwise surface as an opaque server error.
      if (err instanceof McpError && REPORT_DB_UNSYNCED_RE.test(err.message)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `CIPP has no cached mailbox data for tenant ${tenantFilter}, so tenant-wide sizes ` +
            'are unavailable. Mailbox and archive sizes are only stored in CIPP\'s reporting ' +
            'database — the live Exchange query returns no size fields at all. Sync it from ' +
            'CIPP under Reports → Report Settings (or run the Mailboxes cache job), then retry. ' +
            'For a single mailbox, cipp_get_mailbox_usage reads live and needs no cache.'
        );
      }
      throw err;
    }

    // Non-paginated report reads return a bare array; the paginated form wraps
    // it as { Results, Metadata }. Accept either rather than assuming.
    const results = Array.isArray(raw) ? raw : (raw as { Results?: unknown })?.Results;
    const records = (Array.isArray(results) ? results : []).filter(
      (r): r is Record<string, unknown> => typeof r === 'object' && r !== null
    );

    // Newest cache timestamp, taken in one pass — a page can span tenants, so
    // the rows do not arrive in timestamp order.
    let cachedAt: string | undefined;
    for (const record of records) {
      const stamp = stringField(record.CacheTimestamp);
      if (stamp !== undefined && (cachedAt === undefined || stamp > cachedAt)) cachedAt = stamp;
    }

    const rows = records.map(normaliseReportRow);
    const { summary, warnings } = summariseMailboxUsage(rows);

    const threshold = minSizeGB === undefined ? undefined : minSizeGB * GIB;
    // Already a fresh array in both branches, so this sorts in place safely.
    const matching =
      threshold === undefined ? rows : rows.filter((r) => totalMailboxBytes(r) >= threshold);

    matching.sort((a, b) => {
      const left = sortValue(a, sortBy);
      const right = sortValue(b, sortBy);
      if (left === right) return 0;
      // Unknown figures sort last in either direction rather than reading as 0,
      // which would rank an unmeasured mailbox as the emptiest one.
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return right - left;
    });

    const mailboxes = matching.slice(0, limit);

    return {
      tenantFilter,
      source: 'reportDatabase',
      cachedAt,
      summary,
      // An empty array survives JSON.stringify where an undefined key does not,
      // so this one stays conditional.
      ...(warnings.length > 0 && { warnings }),
      sortedBy: sortBy,
      minSizeGB,
      totalMatching: matching.length,
      returned: mailboxes.length,
      mailboxes,
    };
  }

  /**
   * Configure an out-of-office auto-reply for a mailbox.
   * Calls the `ExecSetOoO` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param upn          - User principal name of the mailbox owner.
   * @param oooData      - OoO settings (enabled, internalMessage, externalMessage, etc.).
   */
  async setOutOfOffice<T = unknown>(
    tenantFilter: string,
    upn: string,
    oooData: OutOfOfficeInput
  ): Promise<T> {
    const state = oooData.state;
    if (!OOO_STATES.includes(state)) {
      // Also catches a stale caller still sending the old boolean `enabled`.
      // Failing loudly beats defaulting, which would silently disable the
      // auto-reply for someone who asked to turn it on.
      throw new McpError(
        ErrorCode.InvalidParams,
        `state must be one of ${OOO_STATES.map((s) => `"${s}"`).join(', ')} (got ${JSON.stringify(
          state
        )}). The boolean "enabled" parameter was replaced by "state" because it could not express a scheduled auto-reply.`
      );
    }

    if (state !== 'Scheduled') {
      const stray = OOO_SCHEDULED_ONLY_FIELDS.filter((f) => oooData[f] !== undefined);
      if (stray.length > 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `${stray.join(', ')} only applies when state is "Scheduled"; CIPP ignores these for state "${state}". Set state to "Scheduled" or drop them.`
        );
      }
    }

    // Invoke-ExecSetOoO reads `userId` and `AutoReplyState`, not
    // `UserPrincipalName` / `enabled`. Both of the old keys resolved to $null
    // upstream, so Set-CIPPOutOfOffice ran with no mailbox and no state and
    // failed with a blank username in the error.
    const body: Record<string, unknown> = {
      tenantFilter,
      userId: upn,
      AutoReplyState: state,
    };

    // CIPP applies a message only when it is non-empty, so the state can be
    // flipped without wiping the existing text. Omitting is correct, not a gap.
    if (nonEmpty(oooData.internalMessage)) body.InternalMessage = oooData.internalMessage;
    if (nonEmpty(oooData.externalMessage)) body.ExternalMessage = oooData.externalMessage;
    // Applied by upstream for every state, not just Scheduled. Newer CIPP only.
    if (nonEmpty(oooData.timezone)) body.timezone = oooData.timezone;

    if (state === 'Scheduled') {
      // Upstream converts a `^\d+$` value via FromUnixTimeSeconds and otherwise
      // passes the string through to Exchange, so epoch is the unambiguous form.
      const startTime =
        oooData.startTime !== undefined ? toUnixSeconds(oooData.startTime, 'startTime') : undefined;
      const endTime =
        oooData.endTime !== undefined ? toUnixSeconds(oooData.endTime, 'endTime') : undefined;

      if (startTime !== undefined && endTime !== undefined && endTime <= startTime) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `endTime (${oooData.endTime}) must be after startTime (${oooData.startTime}).`
        );
      }
      if (startTime !== undefined) body.StartTime = startTime;
      if (endTime !== undefined) body.EndTime = endTime;

      if (oooData.createOOFEvent !== undefined) body.CreateOOFEvent = oooData.createOOFEvent;
      if (nonEmpty(oooData.oofEventSubject)) body.OOFEventSubject = oooData.oofEventSubject;
      if (oooData.autoDeclineFutureRequestsWhenOOF !== undefined) {
        body.AutoDeclineFutureRequestsWhenOOF = oooData.autoDeclineFutureRequestsWhenOOF;
      }
      // Upstream fans this one out to DeclineAllEventsForScheduledOOF too.
      if (oooData.declineEventsForScheduledOOF !== undefined) {
        body.DeclineEventsForScheduledOOF = oooData.declineEventsForScheduledOOF;
      }
      if (nonEmpty(oooData.declineMeetingMessage)) {
        body.DeclineMeetingMessage = oooData.declineMeetingMessage;
      }
    }

    return this.request<T>('POST', 'ExecSetOoO', undefined, body);
  }

  /**
   * Configure email forwarding for a mailbox.
   * Calls the `ExecEmailForward` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param upn          - User principal name of the mailbox owner.
   * @param forwardData  - Forwarding settings (forwardTo, keepCopy, etc.).
   */
  async setEmailForwarding<T = unknown>(
    tenantFilter: string,
    upn: string,
    forwardData: Record<string, unknown>
  ): Promise<T> {
    const forwardTo =
      typeof forwardData.forwardTo === 'string' ? forwardData.forwardTo.trim() : '';
    const keepCopy = forwardData.keepCopy === true;

    // Invoke-ExecEmailForward switches on `forwardOption` and assigns a status
    // code only inside a matching branch. With none sent, no branch matched,
    // $StatusCode stayed $null, and the PowerShell worker crashed building the
    // response — an opaque 500 in every mode, not just disable. Note the
    // lowercase key but capital-E `ExternalAddress` value; both are CIPP's.
    // KeepCopy is compared against the string 'true' upstream.
    const body: Record<string, unknown> = {
      tenantFilter,
      userID: upn,
      KeepCopy: keepCopy ? 'true' : 'false',
    };

    if (!forwardTo) {
      body.forwardOption = 'disabled';
    } else {
      const at = forwardTo.lastIndexOf('@');
      if (at < 1) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `forwardTo must be a full email address (got "${forwardTo}"). Omit it entirely to disable forwarding.`
        );
      }
      // CIPP models internal and external forwarding as different Exchange
      // properties, so the mode is derived from whether the target sits on one
      // of the tenant's own domains. Costs one ListDomains GET on the set path
      // only; disabling skips it.
      const domain = forwardTo.slice(at + 1).toLowerCase();
      const domains = await this.listDomains<Array<{ id?: string }>>(tenantFilter);
      const isInternal = (Array.isArray(domains) ? domains : []).some(
        (d) => typeof d?.id === 'string' && d.id.toLowerCase() === domain
      );

      if (isInternal) {
        body.forwardOption = 'internalAddress';
        body.ForwardInternal = { value: forwardTo };
      } else {
        body.forwardOption = 'ExternalAddress';
        body.ForwardExternal = forwardTo;
      }
    }

    return this.request<T>('POST', 'ExecEmailForward', undefined, body);
  }

  // -------------------------------------------------------------------------
  // Security & Conditional Access
  // -------------------------------------------------------------------------

  /**
   * List all Conditional Access policies in a tenant.
   * Calls the `ListConditionalAccessPolicies` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listConditionalAccessPolicies<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListConditionalAccessPolicies', { tenantFilter });
  }

  /**
   * List all named locations defined in a tenant's Conditional Access configuration.
   * Calls the `ListNamedLocations` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listNamedLocations<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListNamedLocations', { tenantFilter });
  }

  // -------------------------------------------------------------------------
  // Standards
  // -------------------------------------------------------------------------

  /**
   * List CIPP standards (best-practice policies) configured for a tenant.
   * Calls the `ListStandards` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listStandards<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListStandards', { tenantFilter });
  }

  /**
   * Trigger a standards compliance check run for a tenant.
   * Calls the `ExecStandardsRun` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async runStandardsCheck<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ExecStandardsRun', { tenantFilter });
  }

  /**
   * List the CIPP Standards Templates configured across the partner tenant.
   * Calls the `listStandardTemplates` Azure Function.
   */
  async listStandardTemplates<T = unknown>(): Promise<T> {
    // CIPP names this function with a lowercase 'l' — do not capitalise.
    return this.request<T>('GET', 'listStandardTemplates');
  }

  /**
   * Report standards drift for a tenant, or for every tenant when no
   * `tenantFilter` is given. Calls the `ListTenantDrift` Azure Function.
   *
   * @param tenantFilter - Optional tenant domain or identifier.
   */
  async getTenantDrift<T = unknown>(tenantFilter?: string): Promise<T> {
    return this.request<T>(
      'GET',
      'ListTenantDrift',
      tenantFilter ? { tenantFilter } : undefined
    );
  }

  /**
   * Report each tenant's alignment percentage against its assigned
   * Standards Templates, or for every tenant when no `tenantFilter` is
   * given. Calls the `ListTenantAlignment` Azure Function.
   *
   * @param tenantFilter - Optional tenant domain or identifier.
   */
  async getTenantAlignment<T = unknown>(tenantFilter?: string): Promise<T> {
    return this.request<T>(
      'GET',
      'ListTenantAlignment',
      tenantFilter ? { tenantFilter } : undefined
    );
  }

  /**
   * Create or update a CIPP Standards Template (CIPP upserts by GUID).
   * Calls the `AddStandardsTemplate` Azure Function.
   *
   * The template object is passed through to CIPP unchanged — cipp-mcp
   * does not model CIPP's template schema, which keeps this tool stable
   * across CIPP versions. Validation is intentionally light: the object
   * must exist and carry a `tenantFilter` assigning it to at least one
   * tenant (CIPP itself rejects templates without one).
   *
   * @param template - The full Standards Template JSON object.
   */
  async createStandardTemplate<T = unknown>(
    template: Record<string, unknown>
  ): Promise<T> {
    if (template === null || typeof template !== 'object' || Array.isArray(template)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Standards template must be a JSON object.'
      );
    }
    if (template.tenantFilter === undefined || template.tenantFilter === null) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Standards template must include a "tenantFilter" assigning it to at least one tenant.'
      );
    }
    return this.request<T>('POST', 'AddStandardsTemplate', undefined, template);
  }

  /**
   * Delete a CIPP Standards Template by ID.
   * Calls the `RemoveStandardTemplate` Azure Function.
   *
   * @param templateId - The GUID of the Standards Template to delete.
   */
  async deleteStandardTemplate<T = unknown>(templateId: string): Promise<T> {
    return this.request<T>('POST', 'RemoveStandardTemplate', undefined, {
      ID: templateId,
    });
  }

  /**
   * Retrieve Best Practice Analyser (BPA) results for a tenant.
   * Calls the `ListBPA` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listBPA<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListBPA', { tenantFilter });
  }

  /**
   * List the DNS domains registered in a tenant.
   * Calls the `ListDomains` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listDomains<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListDomains', { tenantFilter });
  }

  /**
   * Check DNS health (SPF, DMARC, DKIM) for every domain in a tenant.
   *
   * The CIPP `ListDomainHealth` Azure Function is a per-domain DNS helper: it
   * requires `Action` + `Domain` query parameters and ignores `tenantFilter`.
   * Called with only `tenantFilter` it returns HTTP 200 with an empty body.
   * This method therefore enumerates the tenant's domains via `ListDomains`
   * first, then runs the SPF / DMARC / DKIM checks per domain.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @returns One {@link DomainHealthCheck} per domain in the tenant.
   */
  async listDomainHealth(tenantFilter: string): Promise<DomainHealthCheck[]> {
    const domains = await this.listDomains<Array<{ id?: string }>>(tenantFilter);
    const domainNames = (Array.isArray(domains) ? domains : [])
      .map((d) => d?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      // Skip the tenant's `.onmicrosoft.com` routing domain: it carries no
      // real customer mail DNS, so SPF/DMARC/DKIM checks against it only
      // ever hang or fail with no actionable result.
      .filter((id) => !id.toLowerCase().endsWith('.onmicrosoft.com'));

    return Promise.all(
      domainNames.map(async (domain) => {
        const [spf, dmarc, dkim] = await Promise.all([
          this.checkDomainRecord(domain, 'ReadSpfRecord'),
          this.checkDomainRecord(domain, 'ReadDmarcPolicy'),
          this.checkDomainRecord(domain, 'ReadDkimRecord'),
        ]);
        return { domain, spf, dmarc, dkim };
      })
    );
  }

  /**
   * Run a single `ListDomainHealth` DNS check for one domain. Per-check
   * failures are captured so one bad lookup does not sink the whole tenant.
   */
  private async checkDomainRecord(domain: string, action: string): Promise<unknown> {
    try {
      return await this.request(
        'GET',
        'ListDomainHealth',
        { Action: action, Domain: domain },
        undefined,
        DOMAIN_HEALTH_CHECK_TIMEOUT_MS
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Licenses
  // -------------------------------------------------------------------------

  /**
   * List Microsoft 365 license assignments within a tenant.
   * Calls the `ListLicenses` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   */
  async listLicenses<T = unknown>(tenantFilter: string): Promise<T> {
    return this.request<T>('GET', 'ListLicenses', { tenantFilter });
  }

  /**
   * List all CSP-level license subscriptions across the partner account.
   * Calls the `ListCSPLicenses` Azure Function.
   */
  async listCSPLicenses<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListCSPLicenses');
  }

  // -------------------------------------------------------------------------
  // Alerts
  // -------------------------------------------------------------------------

  /**
   * List audit log entries for a tenant, optionally filtered by date and type.
   * Calls the `ListAuditLogs` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param params       - Optional filter parameters.
   * @param params.Days  - Number of past days to include in the results.
   * @param params.Type  - Audit log category to filter by (e.g. `"AzureActiveDirectory"`).
   */
  async listAuditLogs<T = unknown>(
    tenantFilter: string,
    params?: { Days?: number; Type?: string }
  ): Promise<T> {
    return this.request<T>('GET', 'ListAuditLogs', { tenantFilter, ...params });
  }

  /**
   * Retrieve the current CIPP alert queue.
   * Calls the `ListAlertsQueue` Azure Function.
   */
  async listAlertQueue<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListAlertsQueue');
  }

  // -------------------------------------------------------------------------
  // GDAP
  // -------------------------------------------------------------------------

  /**
   * List available Granular Delegated Admin Privileges (GDAP) roles.
   * Calls the `ListGDAPRoles` Azure Function.
   */
  async listGDAPRoles<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListGDAPRoles');
  }

  /**
   * List pending and accepted GDAP relationship invitations.
   * Calls the `ListGDAPInvite` Azure Function.
   */
  async listGDAPInvites<T = unknown>(): Promise<T> {
    return this.request<T>('GET', 'ListGDAPInvite');
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  /**
   * List scheduled items (recurring jobs) managed by CIPP.
   * Calls the `ListScheduledItems` Azure Function.
   *
   * @param params - Optional filter / paging parameters passed as the POST body.
   */
  async listScheduledItems<T = unknown>(params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', 'ListScheduledItems', undefined, params ?? {});
  }

  /**
   * Add a new scheduled item (recurring job) to CIPP.
   * Calls the `AddScheduledItem` Azure Function.
   *
   * Three upstream contracts drive the mapping here: `Add-CIPPScheduledTask`
   * stores `$task.Name` (not `taskName`), casts `ScheduledTime` with
   * `[int64]` (so an ISO string throws into an unhandled 500), and *returns*
   * error strings rather than throwing for blocked/unknown/duplicate commands
   * — which `Invoke-AddScheduledItem` then serves with a hardcoded HTTP 200.
   *
   * @param itemData - Scheduled item properties.
   */
  async addScheduledItem<T = unknown>(itemData: ScheduledItemInput): Promise<T> {
    const body: Record<string, unknown> = {
      Name: itemData.taskName,
      // Older CIPP stores `[string]$task.Command.value` with no bare-string
      // fallback, so always send the { value } shape.
      Command: { value: itemData.command },
      ScheduledTime: toUnixSeconds(itemData.scheduledTime, 'scheduledTime'),
    };
    if (itemData.recurrence !== undefined) body.Recurrence = itemData.recurrence;
    if (itemData.tenantFilter !== undefined) body.TenantFilter = itemData.tenantFilter;
    if (itemData.parameters !== undefined) body.Parameters = itemData.parameters;

    const response = await this.request<{ Results?: unknown }>(
      'POST',
      'AddScheduledItem',
      undefined,
      body
    );
    const { results, failures } = interpretResults(response?.Results);

    return {
      status: failures.length > 0 ? 'failed' : 'added',
      taskName: itemData.taskName,
      results,
      failures,
      message:
        failures.length > 0
          ? `CIPP returned HTTP 200 but reported a failure adding scheduled task "${itemData.taskName}". Do NOT report success to the caller: ${failures.join(' | ')}`
          : `Scheduled task "${itemData.taskName}" added.`,
    } as T;
  }

  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------

  /**
   * List enterprise applications (service principals) in a tenant.
   * Calls the `ListGraphRequest` Azure Function with the `/servicePrincipals` Graph endpoint.
   *
   * Used to discover third-party SaaS apps customers have integrated via OAuth
   * (Slack, Salesforce, Zoom, etc.) — the foundation of the data-driven catalog
   * audit that ranks customer SaaS apps by tenant-frequency.
   *
   * @param tenantFilter - Tenant domain or identifier, or 'allTenants' for cross-tenant fan-out.
   * @param params - Optional filter parameters.
   * @param params.includeBuiltIn - When true, includes Microsoft-built-in service principals
   *   (owner org f8cdef31-a31e-4b4a-93e4-5f571e91255a). Defaults to false (third-party only).
   *
   * @remarks
   * For `tenantFilter='allTenants'`, CIPP's `ListGraphRequest` backend handles the fan-out
   * across all managed tenants server-side and represents per-tenant errors (e.g. 403 from a
   * tenant that hasn't granted GDAP delegated admin) as inline error rows in the response —
   * one opt-out does NOT fail the whole call.
   */
  async listEnterpriseApps<T = unknown>(
    tenantFilter: string,
    params?: { includeBuiltIn?: boolean }
  ): Promise<T> {
    const MICROSOFT_OWNER_ORG_ID = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
    const query: Record<string, unknown> = {
      tenantFilter,
      Endpoint: '/servicePrincipals',
      $select:
        'appId,displayName,publisherName,appOwnerOrganizationId,signInAudience,tags,createdDateTime',
    };
    if (!params?.includeBuiltIn) {
      query.$filter = `appOwnerOrganizationId ne ${MICROSOFT_OWNER_ORG_ID}`;
    }
    return this.request<T>('GET', 'ListGraphRequest', query);
  }
}
