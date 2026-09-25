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
 * CIPP's failure vocabulary as it appears inside a `Results` payload.
 *
 * Several CIPP entrypoints (`Invoke-EditUser`, `Invoke-AddScheduledItem`,
 * `Invoke-ExecOffboardUser`) hardcode HTTP 200 and report failures as plain
 * strings in `Results`, so a `response.ok` check alone reports success on
 * failure.
 */
const CIPP_FAILURE_RE =
  /fail|error|could not|unable|not permitted|already exists|does not exist/i;

/**
 * Normalise a CIPP `Results` payload — a string, an array, or absent — into
 * strings, and flag the entries that report a failure. Parse, never assume.
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

  const results = entries.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  return { results, failures: results.filter((r) => CIPP_FAILURE_RE.test(r)) };
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
// Sign-in logs
// ---------------------------------------------------------------------------

/**
 * `Invoke-ListUserSigninLogs` defaults `top` to 50 and interpolates it straight
 * into Graph's `$top`. Graph caps `auditLogs/signIns` pages at 1000, and the
 * handler fetches a single page (`-noPagination $true`), so 1000 is the most a
 * single call can ever return.
 */
const SIGNIN_LOGS_DEFAULT_TOP = 50;
const SIGNIN_LOGS_MAX_TOP = 1000;

/**
 * Graph's reply when the tenant lacks the Entra ID P1/P2 licence that sign-in
 * log API access requires. Upstream wraps it in a generic "Failed to retrieve
 * Sign In report" string, which reads like a CIPP fault rather than a licence
 * gap. Matched narrowly: the error message embeds the request URL, so a bare
 * /premium/ would fire for any tenant whose domain contains the word.
 */
const SIGNIN_PREMIUM_REQUIRED_RE =
  /RequestFromNonPremiumTenant|(?:doesn't|does not|don't|do not) have (?:a |an )?premium licen[cs]e|premium licen[cs]e is required/i;

/** Applied Conditional Access policy outcomes that carry no information. */
const CA_POLICY_NOISE = new Set(['notApplied', 'notEnabled', 'unknownFutureValue']);

/** Risk values Graph uses to mean "nothing to report". */
const RISK_NOISE = new Set(['none', 'hidden', 'unknownFutureValue']);

/** One sign-in, flattened from a Graph `signIn` object to what a technician reads. */
export interface SignInLogRow {
  /** `createdDateTime`, ISO 8601 UTC. */
  time?: string;
  app?: string;
  /** The resource the token was issued for, e.g. "Microsoft Graph". */
  resource?: string;
  ipAddress?: string;
  /** "City, State, CC" — whichever parts Graph supplied. */
  location?: string;
  /** `success` when Graph's `status.errorCode` is 0, `failure` for any other code. */
  status?: 'success' | 'failure';
  errorCode?: number;
  failureReason?: string;
  additionalDetails?: string;
  /** e.g. "Browser", "Mobile Apps and Desktop clients", "Exchange ActiveSync". */
  clientApp?: string;
  /** `success`, `failure` or `notApplied`. */
  conditionalAccessStatus?: string;
  /** Policies that actually evaluated (applied or failed); not-applied noise is dropped. */
  conditionalAccessPolicies?: Array<{ name?: string; result?: string }>;
  /** `singleFactorAuthentication` or `multiFactorAuthentication`. */
  authenticationRequirement?: string;
  /**
   * Authentication steps Graph recorded, first factor included — a password-only
   * sign-in shows methods ["Password"]. Whether MFA was required is
   * `authenticationRequirement`, not the presence of this block.
   */
  authentication?: {
    methods?: string[];
    detail?: string;
    steps?: Array<{ method?: string; succeeded?: boolean; detail?: string }>;
  };
  device?: {
    name?: string;
    operatingSystem?: string;
    browser?: string;
    isCompliant?: boolean;
    isManaged?: boolean;
    trustType?: string;
  };
  /** Present only when Graph flagged risk on the sign-in. */
  risk?: { level?: string; state?: string; detail?: string };
  isInteractive?: boolean;
  userAgent?: string;
  correlationId?: string;
  id?: string;
}

/** What {@link CippService.listUserSigninLogs} returns. */
export interface UserSigninLogListing {
  tenantFilter: string;
  userId: string;
  userPrincipalName: string;
  /** The `top` sent upstream — the most rows this call could have returned. */
  requested: number;
  returned: number;
  summary: {
    successful: number;
    failed: number;
    distinctIpAddresses: number;
    countries: string[];
    /** Newest and oldest sign-in in this page. */
    newest?: string;
    oldest?: string;
  };
  warnings?: string[];
  signIns: SignInLogRow[];
}

/** Read a finite number field, else undefined. */
function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a boolean field, else undefined. */
function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Drop keys whose value is `undefined`; return `undefined` if nothing is left. */
function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/** Treat a value as a plain object, or an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Flatten one Graph beta `signIn` object.
 *
 * Only fields Graph actually populated are emitted; an absent MFA or risk block
 * means Graph recorded none, not that the check was skipped here.
 */
function normaliseSignIn(raw: Record<string, unknown>): SignInLogRow {
  const status = asRecord(raw.status);
  const location = asRecord(raw.location);
  const device = asRecord(raw.deviceDetail);
  const mfaDetail = asRecord(raw.mfaDetail);

  const errorCode = numberField(status.errorCode);
  const place = [location.city, location.state, location.countryOrRegion]
    .filter(nonEmpty)
    .join(', ');

  const policies = (Array.isArray(raw.appliedConditionalAccessPolicies)
    ? raw.appliedConditionalAccessPolicies
    : []
  )
    .map(asRecord)
    .filter((p) => !(typeof p.result === 'string' && CA_POLICY_NOISE.has(p.result)))
    .map((p) => ({ name: stringField(p.displayName), result: stringField(p.result) }));

  // authenticationDetails (beta) is the current record of each auth step;
  // mfaDetail is the older single-method summary. Keep whichever exists.
  const steps = (Array.isArray(raw.authenticationDetails) ? raw.authenticationDetails : [])
    .map(asRecord)
    .map((s) =>
      compact({
        method: stringField(s.authenticationMethod),
        succeeded: booleanField(s.succeeded),
        detail: stringField(s.authenticationStepResultDetail),
      })
    )
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const methods = [
    ...new Set(
      [
        ...steps.map((s) => s.method),
        stringField(mfaDetail.authMethod),
      ].filter(nonEmpty)
    ),
  ];
  const authentication = compact({
    methods: methods.length > 0 ? methods : undefined,
    detail: stringField(mfaDetail.authDetail),
    steps: steps.length > 0 ? steps : undefined,
  });

  const riskValue = (v: unknown) =>
    nonEmpty(v) && !RISK_NOISE.has(v) ? v : undefined;
  const risk = compact({
    level: riskValue(raw.riskLevelDuringSignIn) ?? riskValue(raw.riskLevelAggregated),
    state: riskValue(raw.riskState),
    detail: riskValue(raw.riskDetail),
  });

  return {
    time: stringField(raw.createdDateTime),
    app: stringField(raw.appDisplayName),
    resource: stringField(raw.resourceDisplayName),
    ipAddress: stringField(raw.ipAddress),
    location: place || undefined,
    status: errorCode === undefined ? undefined : errorCode === 0 ? 'success' : 'failure',
    errorCode,
    failureReason: errorCode === 0 ? undefined : stringField(status.failureReason),
    additionalDetails: stringField(status.additionalDetails),
    clientApp: stringField(raw.clientAppUsed),
    conditionalAccessStatus: stringField(raw.conditionalAccessStatus),
    conditionalAccessPolicies: policies.length > 0 ? policies : undefined,
    authenticationRequirement: stringField(raw.authenticationRequirement),
    authentication,
    device: compact({
      name: stringField(device.displayName),
      operatingSystem: stringField(device.operatingSystem),
      browser: stringField(device.browser),
      isCompliant: booleanField(device.isCompliant),
      isManaged: booleanField(device.isManaged),
      trustType: stringField(device.trustType),
    }),
    risk,
    isInteractive: booleanField(raw.isInteractive),
    userAgent: stringField(raw.userAgent),
    correlationId: stringField(raw.correlationId),
    id: stringField(raw.id),
  };
}

// ---------------------------------------------------------------------------
// SharePoint library copy
// ---------------------------------------------------------------------------

/** `NameConflictBehavior` values `Invoke-ExecSiteBrowserLibraryCopy` maps by name. */
const LIBRARY_COPY_CONFLICT_BEHAVIORS = ['Fail', 'Replace'] as const;
export type LibraryCopyConflictBehavior = (typeof LIBRARY_COPY_CONFLICT_BEHAVIORS)[number];

/** Arguments accepted by {@link CippService.startLibraryCopy}. */
export interface LibraryCopyInput {
  tenantFilter: string;
  /** Graph site id of the source site. Required in practice — see {@link CippService.startLibraryCopy}. */
  sourceSiteId: string;
  /** SharePoint list GUID of the source document library. */
  sourceListId: string;
  destSiteId: string;
  destListId: string;
  sourceSiteUrl?: string;
  destSiteUrl?: string;
  /** Display labels stored on the operation row; CIPP falls back to the site / library titles. */
  sourceSiteName?: string;
  sourceLibraryName?: string;
  destSiteName?: string;
  destLibraryName?: string;
  /** Upstream default is `Replace`, which overwrites same-named items at the destination. */
  nameConflictBehavior?: LibraryCopyConflictBehavior;
  /**
   * Copy into a folder of this name at the destination library's root instead
   * of the root itself. Requires a CIPP build carrying the `DestFolderName`
   * patch; older builds ignore it and copy to the library root.
   */
  destFolderName?: string;
  /** Run `PreflightLibraryCopy` (count and validate only) instead of starting the copy. */
  preflightOnly?: boolean;
}

/** Normalised library-copy states reported by {@link CippService.getLibraryCopyStatus}. */
export type LibraryCopyState = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial' | 'unknown';

/**
 * Characters SharePoint refuses in a file or folder name. Mirrors the
 * validation the `DestFolderName` CIPP patch applies server-side, so a bad
 * name fails here rather than after a round trip.
 */
const SHAREPOINT_ILLEGAL_NAME_CHARS_RE = /["*:<>?/\\|]/;

/**
 * Names SharePoint refuses for a file or folder, compared case-insensitively.
 * Must stay identical to the list in the patch's
 * `Test-CIPPSharePointLibraryCopyFolderName`.
 */
const SHAREPOINT_RESERVED_NAMES = new Set(
  [
    'Forms',
    '.lock',
    'desktop.ini',
    'CON',
    'PRN',
    'AUX',
    'NUL',
    ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
    ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
  ].map((n) => n.toLowerCase())
);

/**
 * Validate and normalise a destination folder name.
 *
 * Returns the trimmed name. A supplied-but-blank value is rejected rather than
 * dropped: dropping it would silently copy into the library root, the exact
 * outcome a caller naming a folder was trying to avoid.
 */
export function validateLibraryFolderName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'destFolderName must be a string.');
  }
  const name = value.trim();
  if (name === '') {
    throw new McpError(
      ErrorCode.InvalidParams,
      'destFolderName is empty. Omit it to copy into the library root, or supply a folder name.'
    );
  }
  if (/^[.\s]+$/.test(name)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `destFolderName "${value}" consists only of dots and whitespace, which SharePoint does not allow.`
    );
  }
  if (name.length > 255) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `destFolderName is ${name.length} characters long; SharePoint allows at most 255.`
    );
  }
  const illegal = name.match(SHAREPOINT_ILLEGAL_NAME_CHARS_RE);
  if (illegal) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `destFolderName "${value}" contains "${illegal[0]}". SharePoint folder names cannot contain ` +
        'any of " * : < > ? / \\ | — and path separators are refused because the folder is created ' +
        'directly at the library root, not as a nested path.'
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F]/.test(name)) {
    throw new McpError(ErrorCode.InvalidParams, 'destFolderName cannot contain control characters.');
  }
  if (name.startsWith('~$') || /_vti_/i.test(name)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `destFolderName "${value}" cannot start with "~$" or contain "_vti_"; SharePoint reserves both.`
    );
  }
  if (SHAREPOINT_RESERVED_NAMES.has(name.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `destFolderName "${name}" is a name SharePoint reserves and cannot be used for a folder.`
    );
  }
  return name;
}

/**
 * Pull the `Results` payload out of a CIPP HTTP-error McpError.
 *
 * Both library-copy entrypoints report every failure as HTTP 400 with the
 * sentence in `Results`, which {@link CippService.request} folds into its
 * error message after the URL. Returns undefined when no JSON body is found.
 */
function resultsFromHttpError(err: unknown): unknown {
  if (!(err instanceof McpError)) return undefined;
  const brace = err.message.indexOf('{');
  if (brace < 0) return undefined;
  try {
    const parsed = JSON.parse(err.message.slice(brace)) as { Results?: unknown };
    return parsed?.Results;
  } catch {
    return undefined;
  }
}

/**
 * The upstream HTTP status {@link CippService.request} recorded in its error
 * message ("CIPP API returned HTTP <status> ..."), as " (HTTP <status>)" for
 * appending to a rewritten message, or "" when there is none.
 */
function httpStatusSuffix(err: unknown): string {
  const status = err instanceof Error ? /\bHTTP (\d{3})\b/.exec(err.message)?.[1] : undefined;
  return status ? ` (HTTP ${status})` : '';
}

/** Case-insensitive property read, since PowerShell serialises with whatever casing it was built with. */
function readProp(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const record = obj as Record<string, unknown>;
  if (key in record) return record[key];
  const lower = key.toLowerCase();
  const match = Object.keys(record).find((k) => k.toLowerCase() === lower);
  return match !== undefined ? record[match] : undefined;
}

/**
 * Flatten `Update-CIPPSharePointLibraryCopyStatus`' `Errors` / `Warnings`
 * (arrays of `{ Severity, Message }`, de-duplicated upstream) into strings.
 */
function issueMessages(raw: unknown): string[] {
  const entries = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return entries
    .map((e) => {
      if (typeof e === 'string') return e;
      const message = readProp(e, 'Message');
      return typeof message === 'string' ? message : JSON.stringify(e);
    })
    .filter((m) => m.trim() !== '');
}

/**
 * Map CIPP's operation status onto the normalised vocabulary.
 *
 * Upstream (`Update-CIPPSharePointLibraryCopyStatus`) emits `Processing`,
 * `Completed`, `CompletedWithErrors` and `Failed`; a freshly chunked row may
 * also carry `Queued`. Two refinements:
 *
 * - `CompletedWithErrors` covers both "some items failed" and "every job
 *   failed". It reads as `partial` only when something was actually copied.
 * - `Completed` with a non-zero error count is downgraded to `partial` — the
 *   error count wins over the label, never the other way round.
 */
function normaliseLibraryCopyState(
  upstream: string | undefined,
  figures: { jobsComplete?: number; objectsProcessed?: number; filesCreated?: number; totalErrors?: number; errorCount: number }
): LibraryCopyState {
  const hasErrors = (figures.totalErrors ?? 0) > 0 || figures.errorCount > 0;
  const copiedSomething = (figures.filesCreated ?? 0) > 0 || (figures.objectsProcessed ?? 0) > 0;
  switch ((upstream ?? '').toLowerCase()) {
    case 'queued':
      return 'queued';
    case 'processing':
      return (figures.jobsComplete ?? 0) === 0 && (figures.objectsProcessed ?? 0) === 0
        ? 'queued'
        : 'running';
    case 'completed':
      return hasErrors ? 'partial' : 'succeeded';
    case 'completedwitherrors':
      return copiedSomething ? 'partial' : 'failed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
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
   * CIPP's `Invoke-AddUser` BUILDS the account's userPrincipalName by
   * concatenating the body's `username` and `Domain` fields
   * (`New-CippUser.ps1`):
   *
   * ```powershell
   * $UserPrincipalName = "$($UserObj.username)@$($UserObj.Domain ?
   *                        $UserObj.Domain : $UserObj.PrimDomain.value)"
   * ```
   *
   * It never reads a `userPrincipalName` field — the same contract as
   * `Invoke-EditUser` (see {@link resolveUserIdentity}). Forwarding a full
   * UPN therefore yields either `@` (both halves absent) or a doubled
   * `user@domain@domain`, and upstream 500s with "The domain portion of the
   * userPrincipalName property is invalid. You must use one of the verified
   * domain names in your organization." That message reads like a
   * tenant/verified-domain problem, so it sends you auditing domains, DNS and
   * GDAP instead of the request body.
   *
   * Split the UPN here so callers keep one natural `userPrincipalName`
   * argument.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userData     - User properties to set (displayName, UPN, password, etc.).
   */
  async createUser<T = unknown>(
    tenantFilter: string,
    userData: Record<string, unknown>
  ): Promise<T> {
    const { userPrincipalName, ...rest } = userData;

    if (typeof userPrincipalName !== 'string' || !userPrincipalName.includes('@')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `userPrincipalName must be a full UPN of the form user@domain (received ` +
          `${JSON.stringify(userPrincipalName)}). CIPP builds the account's UPN from ` +
          `separate username and Domain fields.`
      );
    }

    const at = userPrincipalName.lastIndexOf('@');
    const username = userPrincipalName.slice(0, at);
    const domain = userPrincipalName.slice(at + 1);

    if (!username || !domain) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `userPrincipalName "${userPrincipalName}" is missing a local part or a domain.`
      );
    }

    return this.request<T>('POST', 'AddUser', undefined, {
      tenantFilter,
      username,
      Domain: domain,
      ...rest,
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
   * Calls the `ExecDisableUser` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user to disable.
   */
  async disableUser<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('POST', 'ExecDisableUser', undefined, {
      tenantFilter,
      ID: userId,
    });
  }

  /**
   * Reset a user's password.
   * Calls the `ExecResetPass` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user.
   * @param newPassword  - Optional explicit password; omit to let CIPP generate one.
   */
  async resetPassword<T = unknown>(
    tenantFilter: string,
    userId: string,
    newPassword?: string
  ): Promise<T> {
    return this.request<T>('POST', 'ExecResetPass', undefined, {
      tenantFilter,
      ID: userId,
      ...(newPassword && { newPassword }),
    });
  }

  /**
   * Reset all registered MFA methods for a user.
   * Calls the `ExecResetMFA` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user.
   */
  async resetMFA<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('POST', 'ExecResetMFA', undefined, {
      tenantFilter,
      ID: userId,
    });
  }

  /**
   * Revoke all active sign-in sessions for a user.
   * Calls the `ExecRevokeSessions` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user.
   */
  async revokeSessions<T = unknown>(tenantFilter: string, userId: string): Promise<T> {
    return this.request<T>('POST', 'ExecRevokeSessions', undefined, {
      tenantFilter,
      ID: userId,
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
   * List a user's most recent interactive sign-ins, newest first.
   * Calls the `ListUserSigninLogs` Azure Function.
   *
   * `Invoke-ListUserSigninLogs` reads exactly three query parameters —
   * `tenantFilter`, `UserID` and `top` — and interpolates `UserID` unescaped
   * into Graph's `$filter=(userId eq '<UserID>')`. Graph's `userId` is the
   * Entra *object id*: a UPN there matches nothing and comes back as an empty,
   * successful page, indistinguishable from "this user has not signed in".
   * So the user is always resolved first — a UPN to its object id, and an
   * object id checked to exist — and only the resolved GUID is sent.
   *
   * Upstream fetches one page (`-noPagination $true`), with no all-tenants
   * branch. On failure it returns HTTP 500 with the body
   * `["Failed to retrieve Sign In report for user <id> : Error: <reason>"]`.
   *
   * @param tenantFilter - Tenant domain or GUID. `allTenants` is not supported.
   * @param upnOrId      - UPN or Entra object id of the user.
   * @param params.top   - Sign-ins to return, 1–1000. Defaults to 50, as upstream does.
   */
  async listUserSigninLogs(
    tenantFilter: string,
    upnOrId: string,
    params: { top?: number } = {}
  ): Promise<UserSigninLogListing> {
    if (tenantFilter.trim().toLowerCase() === 'alltenants') {
      throw new McpError(
        ErrorCode.InvalidParams,
        "cipp_list_user_signin_logs reads one user's sign-ins in one tenant; allTenants is not " +
          "supported (Invoke-ListUserSigninLogs has no all-tenants branch). Name the user's own " +
          'tenant. For tenant-wide sign-ins, use the Sign-Ins report in CIPP ' +
          '(ListSignIns / ListGraphRequest with Endpoint=auditLogs/signIns).'
      );
    }

    const top = params.top ?? SIGNIN_LOGS_DEFAULT_TOP;
    if (!Number.isInteger(top) || top < 1 || top > SIGNIN_LOGS_MAX_TOP) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `top must be an integer between 1 and ${SIGNIN_LOGS_MAX_TOP}; got ${params.top}.`
      );
    }

    const identity = await this.resolveUserIdentity(
      tenantFilter,
      upnOrId,
      'Sign-in logs are filtered by Entra object id, which could not be determined — ' +
        'querying without it would return an empty page that reads as "no sign-ins".'
    );

    let raw: unknown;
    try {
      raw = await this.request<unknown>('GET', 'ListUserSigninLogs', {
        tenantFilter,
        UserID: identity.id,
        top,
      });
    } catch (err) {
      if (err instanceof McpError && SIGNIN_PREMIUM_REQUIRED_RE.test(err.message)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tenant ${tenantFilter} cannot serve sign-in logs through the API: Microsoft Graph ` +
            'requires an Entra ID P1 or P2 licence in the tenant for auditLogs/signIns. ' +
            `Upstream said: ${err.message}`
        );
      }
      throw err;
    }

    // Success is a bare array of Graph signIn objects. An empty page comes back
    // as `[]` or `[null]` (PowerShell's `@($null)`), so nulls are dropped
    // rather than read as rows. A string in the array is upstream failure text
    // under a 200 — never let that pass as "no sign-ins".
    const entries = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
    const strings = entries.filter((e) => typeof e === 'string');
    if (strings.length > 0) {
      const { results, failures } = interpretResults(strings);
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP ListUserSigninLogs returned a message instead of sign-in records for user ` +
          `${identity.id}: ${(failures.length > 0 ? failures : results).join('; ')}`
      );
    }

    const signIns = entries
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map(normaliseSignIn);

    const countries = [
      ...new Set(
        entries
          .map((e) => asRecord(asRecord(e).location).countryOrRegion)
          .filter(nonEmpty)
      ),
    ].sort();
    const times = signIns.map((s) => s.time).filter(nonEmpty).sort();

    const warnings: string[] = [];
    if (signIns.length === 0) {
      warnings.push(
        `No interactive sign-ins were returned for ${identity.userPrincipalName}. Entra retains ` +
          'sign-in logs for 30 days, and this endpoint returns interactive sign-ins only — ' +
          'non-interactive, service-principal and managed-identity sign-ins are not included.'
      );
    } else if (signIns.length >= top) {
      warnings.push(
        `Returned the ${top} most recent sign-ins, which is the limit requested; older ` +
          `sign-ins may exist. Raise top (maximum ${SIGNIN_LOGS_MAX_TOP}) to see further back.`
      );
    }

    return {
      tenantFilter,
      userId: identity.id,
      userPrincipalName: identity.userPrincipalName,
      requested: top,
      returned: signIns.length,
      summary: {
        successful: signIns.filter((s) => s.status === 'success').length,
        failed: signIns.filter((s) => s.status === 'failure').length,
        distinctIpAddresses: new Set(signIns.map((s) => s.ipAddress).filter(nonEmpty)).size,
        countries,
        newest: times[times.length - 1],
        oldest: times[0],
      },
      ...(warnings.length > 0 && { warnings }),
      signIns,
    };
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
   * Create a new Azure AD group in a tenant.
   * Calls the `AddGroup` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param groupData    - Group properties (displayName, groupType, etc.).
   */
  async createGroup<T = unknown>(
    tenantFilter: string,
    groupData: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>('POST', 'AddGroup', undefined, { tenantFilter, ...groupData });
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
  // SharePoint library copy
  // -------------------------------------------------------------------------

  /**
   * Start (or preflight) a SharePoint document-library content copy.
   * Calls the `ExecSiteBrowserLibraryCopy` Azure Function with
   * `Action: StartLibraryCopy` (or `PreflightLibraryCopy`).
   *
   * Upstream contracts this mirrors, from `Invoke-ExecSiteBrowserLibraryCopy`
   * and `Start-CIPPSharePointLibraryCopy`:
   *
   * - Site ids are required even though the entrypoint's own check accepts a
   *   URL instead: it passes `[string]$null` (an empty string) into
   *   `Start-CIPPSharePointLibraryCopy`, whose `SourceSiteId` / `DestSiteId`
   *   are `Mandatory` `[string]`, so a URL-only call dies in parameter binding.
   * - `NameConflictBehavior` defaults to `Replace` upstream; `Fail` and
   *   `Replace` are mapped by name.
   * - The copy is asynchronous (SharePoint `CreateCopyJobs` with
   *   MoveButKeepSource). Success here means jobs were *queued*, never that
   *   content arrived — the returned `OperationId` must be polled with
   *   {@link getLibraryCopyStatus}.
   * - Every failure is HTTP 400 with the reason as a string in `Results`.
   *
   * `DestFolderName` is the one field not yet in upstream CIPP: builds without
   * the patch ignore it silently and copy into the library root. The start
   * result does not reliably say which happened, so when the field is sent
   * and not echoed back, the result carries a warning.
   */
  async startLibraryCopy<T = unknown>(input: LibraryCopyInput): Promise<T> {
    const { tenantFilter } = input;
    if (!nonEmpty(tenantFilter)) {
      throw new McpError(ErrorCode.InvalidParams, 'tenantFilter is required.');
    }
    if (tenantFilter.trim().toLowerCase() === 'alltenants') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'A library copy runs inside one tenant; allTenants is not supported. Pass the tenant that owns both libraries.'
      );
    }
    const required = {
      sourceSiteId: input.sourceSiteId,
      sourceListId: input.sourceListId,
      destSiteId: input.destSiteId,
      destListId: input.destListId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (!nonEmpty(value)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `${field} is required. CIPP binds site ids as mandatory parameters, so a site URL alone is not enough.`
        );
      }
    }
    if (
      input.sourceSiteId.trim() === input.destSiteId.trim() &&
      input.sourceListId.trim().toLowerCase() === input.destListId.trim().toLowerCase()
    ) {
      throw new McpError(ErrorCode.InvalidParams, 'Source and destination library must be different.');
    }
    if (
      input.nameConflictBehavior !== undefined &&
      !(LIBRARY_COPY_CONFLICT_BEHAVIORS as readonly string[]).includes(input.nameConflictBehavior)
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `nameConflictBehavior must be one of ${LIBRARY_COPY_CONFLICT_BEHAVIORS.join(', ')}; got "${String(input.nameConflictBehavior)}".`
      );
    }
    const destFolderName =
      input.destFolderName !== undefined ? validateLibraryFolderName(input.destFolderName) : undefined;

    const action = input.preflightOnly === true ? 'PreflightLibraryCopy' : 'StartLibraryCopy';
    const body: Record<string, unknown> = {
      tenantFilter,
      Action: action,
      SourceSiteId: input.sourceSiteId.trim(),
      SourceListId: input.sourceListId.trim(),
      DestSiteId: input.destSiteId.trim(),
      DestListId: input.destListId.trim(),
    };
    const optional: Array<[string, string | undefined]> = [
      ['SourceSiteUrl', input.sourceSiteUrl],
      ['DestSiteUrl', input.destSiteUrl],
      ['SourceSiteName', input.sourceSiteName],
      ['SourceLibraryName', input.sourceLibraryName],
      ['DestSiteName', input.destSiteName],
      ['DestLibraryName', input.destLibraryName],
      ['NameConflictBehavior', input.nameConflictBehavior],
    ];
    for (const [key, value] of optional) {
      if (nonEmpty(value)) body[key] = value;
    }
    // Only when supplied: an absent field is the unpatched-CIPP behaviour, exactly.
    if (destFolderName !== undefined) body.DestFolderName = destFolderName;

    let response: { Results?: unknown } | undefined;
    try {
      response = await this.request<{ Results?: unknown }>(
        'POST',
        'ExecSiteBrowserLibraryCopy',
        undefined,
        body
      );
    } catch (err) {
      const upstream = resultsFromHttpError(err);
      if (typeof upstream === 'string') {
        throw new McpError(
          ErrorCode.InternalError,
          `CIPP refused the library copy${httpStatusSuffix(err)}: ${upstream}`
        );
      }
      throw err;
    }

    const results = response?.Results;
    if (results === undefined || results === null || typeof results === 'string' || Array.isArray(results)) {
      // The entrypoint returns an object on success. Anything else is a
      // failure sentence, or a shape we do not understand — neither is a copy.
      const { results: lines } = interpretResults(results);
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP returned HTTP 200 without a library copy result. Do NOT report that a copy started: ${
          lines.join(' | ') || '(empty response)'
        }`
      );
    }

    const message = stringField(readProp(results, 'Message'));

    if (action === 'PreflightLibraryCopy') {
      const eligibleRootCount = toFiniteNumber(readProp(results, 'EligibleRootCount'));
      const warnLevel = stringField(readProp(results, 'WarnLevel'));
      const preflightWarnings: string[] = [];
      let destFolderExists: boolean | undefined;
      if (destFolderName !== undefined) {
        // A patched CIPP echoes DestFolderName and reports DestFolderExists on
        // preflight; an unpatched one returns neither.
        const echoed = stringField(readProp(results, 'DestFolderName'));
        const exists = readProp(results, 'DestFolderExists');
        destFolderExists = typeof exists === 'boolean' ? exists : undefined;
        if (echoed === undefined) {
          preflightWarnings.push(
            `CIPP did not confirm DestFolderName "${destFolderName}". This CIPP build probably lacks the ` +
              'DestFolderName patch, in which case a real start would copy into the destination library ROOT.'
          );
        }
      }
      return {
        status: 'preflight',
        tenantFilter,
        eligibleRootCount,
        warnLevel,
        ...(destFolderName !== undefined && { destFolderName }),
        ...(destFolderExists !== undefined && { destFolderExists }),
        ...(preflightWarnings.length > 0 && { warnings: preflightWarnings }),
        upstreamMessage: message,
        message:
          `Preflight passed: ${eligibleRootCount ?? 'an unknown number of'} root item(s) would be copied, ` +
          'one SharePoint copy job each. Nothing was copied. Call again without preflightOnly to start.' +
          (warnLevel && warnLevel !== 'none'
            ? ` CIPP flags this as a large copy (warnLevel "${warnLevel}").`
            : ''),
      } as T;
    }

    const operationId = stringField(readProp(results, 'OperationId'));
    if (!operationId) {
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP returned HTTP 200 but no OperationId, so there is nothing to track. Do NOT report that a copy started. Response: ${JSON.stringify(results)}`
      );
    }

    const warnings: string[] = [];
    if (destFolderName !== undefined) {
      const echoed = stringField(readProp(results, 'DestFolderName'));
      if (echoed === undefined) {
        warnings.push(
          `CIPP did not confirm DestFolderName "${destFolderName}". CIPP builds without the ` +
            'DestFolderName patch ignore it silently and copy into the destination library root ' +
            'instead of the folder. Check the destination library before relying on the folder.'
        );
      } else if (echoed !== destFolderName) {
        warnings.push(
          `CIPP reports copying into folder "${echoed}", not the requested "${destFolderName}".`
        );
      }
    }

    const jobHandleCount = toFiniteNumber(readProp(results, 'JobHandleCount'));
    const createdRaw = destFolderName !== undefined ? readProp(results, 'DestFolderCreated') : undefined;
    const destFolderCreated = typeof createdRaw === 'boolean' ? createdRaw : undefined;
    return {
      status: 'started',
      tenantFilter,
      operationId,
      jobHandleCount,
      ...(destFolderName !== undefined && { destFolderName }),
      ...(destFolderCreated !== undefined && { destFolderCreated }),
      ...(warnings.length > 0 && { warnings }),
      upstreamMessage: message,
      nextStep:
        `Poll cipp_get_library_copy_status with tenantFilter "${tenantFilter}" and operationId ` +
        `"${operationId}" until done is true.`,
      message:
        `Library copy queued as ${jobHandleCount ?? 'an unknown number of'} SharePoint copy job(s). ` +
        'Nothing has been copied yet: this confirms the jobs were created, not that they finished. ' +
        'Do not report the copy as complete until cipp_get_library_copy_status says succeeded.',
    } as T;
  }

  /**
   * Report the progress of a library copy started by {@link startLibraryCopy}.
   * Calls the `ListSiteBrowserLibraryCopy` Azure Function (query:
   * `tenantFilter`, `OperationId`).
   *
   * Upstream (`Update-CIPPSharePointLibraryCopyStatus`) polls every unfinished
   * job on each call and returns a sanitised aggregate. Once the status is
   * `Completed`, `CompletedWithErrors` or `Failed` it stops polling and
   * serves the stored snapshot — including `Failed`, which it sets as soon as
   * any job fails even while others are still running in SharePoint.
   * Per-item errors come back de-duplicated and with file names and URLs
   * redacted upstream, so they identify *what* went wrong rather than *which*
   * file.
   */
  async getLibraryCopyStatus<T = unknown>(tenantFilter: string, operationId: string): Promise<T> {
    if (!nonEmpty(tenantFilter)) {
      throw new McpError(ErrorCode.InvalidParams, 'tenantFilter is required.');
    }
    if (!nonEmpty(operationId)) {
      throw new McpError(ErrorCode.InvalidParams, 'operationId is required.');
    }

    let response: { Results?: unknown } | undefined;
    try {
      response = await this.request<{ Results?: unknown }>('GET', 'ListSiteBrowserLibraryCopy', {
        tenantFilter,
        OperationId: operationId.trim(),
      });
    } catch (err) {
      const upstream = resultsFromHttpError(err);
      if (typeof upstream === 'string') {
        throw new McpError(
          ErrorCode.InternalError,
          `CIPP could not report the status of library copy ${operationId}` +
            `${httpStatusSuffix(err)}: ${upstream}` +
            (/not found/i.test(upstream)
              ? ' Operations are stored per tenant, so check tenantFilter matches the one the copy was started in.'
              : '')
        );
      }
      throw err;
    }

    const snapshot = response?.Results;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      const { results: lines } = interpretResults(snapshot);
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP returned HTTP 200 without a library copy status. Do NOT assume the copy succeeded: ${
          lines.join(' | ') || '(empty response)'
        }`
      );
    }

    const num = (key: string) => toFiniteNumber(readProp(snapshot, key));
    const upstreamStatus = stringField(readProp(snapshot, 'Status'));
    const errors = issueMessages(readProp(snapshot, 'Errors'));
    const warnings = issueMessages(readProp(snapshot, 'Warnings'));
    const figures = {
      jobsComplete: num('JobsComplete'),
      jobsTotal: num('JobsTotal'),
      objectsProcessed: num('ObjectsProcessed'),
      totalExpectedObjects: num('TotalExpectedObjects'),
      progressPercent: num('ProgressPercent'),
      filesCreated: num('FilesCreated'),
      bytesProcessed: num('BytesProcessed'),
      totalErrors: num('TotalErrors'),
      totalWarnings: num('TotalWarnings'),
    };
    const state = normaliseLibraryCopyState(upstreamStatus, { ...figures, errorCount: errors.length });
    const done = state === 'succeeded' || state === 'failed' || state === 'partial';

    const errorCount = figures.totalErrors ?? errors.length;
    let message: string;
    switch (state) {
      case 'queued':
        message = 'Copy jobs are queued in SharePoint and have not started. Poll again later.';
        break;
      case 'running':
        message = `Copy in progress (${figures.jobsComplete ?? '?'} of ${figures.jobsTotal ?? '?'} jobs complete). Poll again later.`;
        break;
      case 'succeeded':
        message = 'Library copy completed with no errors reported.';
        break;
      case 'partial':
        message =
          `Library copy finished with ${errorCount} error(s): some content was copied and some was not. ` +
          'Do NOT report this as a clean success — list the errors to the caller.';
        break;
      case 'failed':
        message =
          'Library copy failed. Do NOT report success.' +
          (upstreamStatus?.toLowerCase() === 'failed'
            ? ' CIPP marks an operation Failed as soon as any copy job fails and stops tracking the rest, so other jobs may still have copied content — check the destination library.'
            : ' No content was reported as copied.');
        break;
      default:
        message = `CIPP reported an unrecognised status "${upstreamStatus ?? '(none)'}". Do NOT assume the copy succeeded.`;
    }

    const destFolderName = stringField(readProp(snapshot, 'DestFolderName'));
    return {
      tenantFilter,
      operationId: stringField(readProp(snapshot, 'OperationId')) ?? operationId,
      state,
      done,
      upstreamStatus,
      ...figures,
      bytesCopied: formatBytes(figures.bytesProcessed),
      errors,
      warnings,
      source: {
        siteName: stringField(readProp(snapshot, 'SourceSiteName')),
        libraryName: stringField(readProp(snapshot, 'SourceLibraryName')),
      },
      destination: {
        siteName: stringField(readProp(snapshot, 'DestSiteName')),
        libraryName: stringField(readProp(snapshot, 'DestLibraryName')),
        ...(destFolderName !== undefined && { folderName: destFolderName }),
      },
      lastUpdatedUtc: stringField(readProp(snapshot, 'LastUpdatedUtc')),
      upstreamMessage: stringField(readProp(snapshot, 'Message')),
      message,
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
