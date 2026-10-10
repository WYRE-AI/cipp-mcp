// CIPP MCP Type Definitions
// Defines all shared interfaces used across the CIPP MCP server.
// CIPP is an Azure Function App providing M365 multi-tenant management for MSPs.

// ---------------------------------------------------------------------------
// MCP Server Configuration
// ---------------------------------------------------------------------------

/**
 * Top-level MCP server configuration, merging server identity with CIPP
 * connection details. Used to initialise both the MCP server and the CIPP
 * API client.
 */
export interface McpServerConfig {
  /** Human-readable server name surfaced to MCP clients. */
  name: string;
  /** SemVer string for this server build. */
  version: string;
  /** CIPP API connection details. */
  cipp: {
    /** Base URL of the CIPP Azure Function App (e.g. https://cipp.contoso.com). */
    baseUrl?: string;
    /**
     * Static Bearer token used to authenticate against CIPP. Mutually exclusive
     * with the OAuth client-credentials fields below — if both are provided,
     * the static `apiKey` wins.
     */
    apiKey?: string;
    /** Entra tenant (directory) ID that owns the CIPP API-client app registration. */
    tenantId?: string;
    /** Application (client) ID of the CIPP API client used for OAuth exchange. */
    clientId?: string;
    /** Application secret value issued for the CIPP API client. */
    clientSecret?: string;
    /**
     * Optional OAuth scope override. When omitted, the token is requested for
     * `api://<clientId>/.default`. An explicit value disables the legacy-scope
     * fallback.
     */
    tokenScope?: string;
    /**
     * When `false`, a CIPP HTTP 401 is not retried with the legacy
     * `<clientId>/.default` scope. Omitted or `true` keeps that one retry
     * enabled and caches whichever audience the client accepts.
     */
    tokenScopeFallback?: boolean;
    /** Optional full token endpoint URL override (sovereign clouds / custom STS). */
    tokenUrl?: string;
  };
}

// ---------------------------------------------------------------------------
// CIPP API Envelope
// ---------------------------------------------------------------------------

/**
 * Generic CIPP API response envelope.
 *
 * CIPP endpoints return either a plural `Results` array or a singular
 * `Result` object depending on the operation. Both fields are optional so
 * callers should check which is present.
 *
 * @template T The type of the payload contained in the response.
 */
export interface CippApiResponse<T> {
  /** Array of results returned by list-style endpoints. */
  Results?: T[];
  /** Single result returned by create/get-by-id style endpoints. */
  Result?: T;
  /** Arbitrary metadata returned alongside the payload (e.g. pagination info). */
  Metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

/**
 * Represents a managed M365 tenant registered in CIPP.
 */
export interface CippTenant {
  /** Unique Azure AD customer identifier for the tenant. Required. */
  customerId: string;
  /** Human-readable name of the tenant. Required. */
  displayName: string;
  /** Primary domain name registered in Azure AD (e.g. contoso.onmicrosoft.com). */
  defaultDomainName?: string;
  /** Azure AD tenant GUID. */
  tenantId?: string;
  /** Delegated admin privilege relationship status (e.g. Active, Pending). */
  delegatedPrivilegeStatus?: string;
  /** ISO 8601 timestamp when this tenant was onboarded into CIPP. */
  onboardingDate?: string;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * Represents an Azure AD / M365 user within a managed tenant.
 */
export interface CippUser {
  /** Azure AD object ID of the user. Required. */
  id: string;
  /** User's UPN (e.g. alice@contoso.com). Required. */
  userPrincipalName: string;
  /** Full display name as shown in the directory. */
  displayName?: string;
  /** Given (first) name. */
  givenName?: string;
  /** Surname (last name). */
  surname?: string;
  /** Primary SMTP address. */
  mail?: string;
  /** User's job title. */
  jobTitle?: string;
  /** Department the user belongs to. */
  department?: string;
  /** Whether the account is enabled and can sign in. */
  accountEnabled?: boolean;
  /** ISO 8601 timestamp when the account was created. */
  createdDateTime?: string;
  /** ISO 8601 timestamp of the user's most recent sign-in. */
  lastSignInDateTime?: string;
  /** List of licence assignment objects attached to the user. */
  assignedLicenses?: Array<Record<string, any>>;
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

/**
 * Represents an Azure AD group (security, Microsoft 365, or distribution).
 */
export interface CippGroup {
  /** Azure AD object ID of the group. Required. */
  id: string;
  /** Human-readable name of the group. */
  displayName?: string;
  /** Primary SMTP address (present for mail-enabled groups). */
  mail?: string;
  /** Classification tags such as "Unified" for Microsoft 365 groups. */
  groupTypes?: string[];
  /** Dynamic membership rule expression (if applicable). */
  membershipRule?: string;
  /** Whether the group is a security group. */
  securityEnabled?: boolean;
  /** Whether the group is mail-enabled. */
  mailEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

/**
 * Represents an Exchange Online mailbox within a managed tenant.
 * Field names use Exchange's PascalCase convention as returned by CIPP.
 */
export interface CippMailbox {
  /** User principal name / primary login address of the mailbox owner. Required. */
  UserPrincipalName: string;
  /** Display name of the mailbox. */
  DisplayName?: string;
  /** Primary SMTP address of the mailbox. */
  PrimarySmtpAddress?: string;
  /** Mailbox plan / SKU assigned (e.g. ExchangeOnline). */
  MailboxPlan?: string;
  /** ISO 8601 timestamp when the mailbox was created. */
  WhenCreated?: string;
  /** ISO 8601 timestamp of the last user action recorded in the mailbox. */
  LastUserActionTime?: string;
}

// ---------------------------------------------------------------------------
// Conditional Access Policy
// ---------------------------------------------------------------------------

/**
 * Represents an Azure AD Conditional Access policy.
 */
export interface CippConditionalAccessPolicy {
  /** Azure AD object ID of the policy. Required. */
  id: string;
  /** Human-readable name of the policy. */
  displayName?: string;
  /** Current enforcement state: "enabled", "disabled", or "enabledForReportingButNotEnforced". */
  state?: string;
  /** ISO 8601 timestamp when the policy was created. */
  createdDateTime?: string;
  /** ISO 8601 timestamp when the policy was last modified. */
  modifiedDateTime?: string;
  /** Conditions block defining when the policy applies (users, apps, locations, etc.). */
  conditions?: any;
  /** Grant controls block defining what happens when conditions are met. */
  grantControls?: any;
}

// ---------------------------------------------------------------------------
// CIPP Standard
// ---------------------------------------------------------------------------

/**
 * Represents a CIPP best-practice standard that can be applied to tenants.
 */
export interface CippStandard {
  /** Human-readable name of the standard. */
  displayName?: string;
  /** Detailed description of what the standard enforces. */
  description?: string;
  /** Impact level of enabling this standard (e.g. "Low", "Medium", "High"). */
  impact?: string;
  /** Taxonomy tags used to group or filter standards. */
  tag?: string[];
  /** Category the standard belongs to (e.g. "Security", "Compliance"). */
  cat?: string;
  /** List of feature flag names that disable specific sub-behaviours of this standard. */
  disabledFeatures?: string[];
}

// ---------------------------------------------------------------------------
// Scheduled Task / Item
// ---------------------------------------------------------------------------

/**
 * Represents a scheduled task or recurring job managed by CIPP.
 */
export interface CippScheduledItem {
  /** Unique Azure Table Storage row key for this scheduled item. Required. */
  RowKey: string;
  /** Serialised task parameters or configuration payload. */
  TaskInfo?: string;
  /** Human-readable name for this scheduled item. */
  Name?: string;
  /** ISO 8601 timestamp of the next (or last) scheduled execution. */
  ScheduledTime?: string;
  /** Recurrence expression (e.g. cron string or friendly interval). */
  Recurrence?: string;
  /** Current status of the scheduled item (e.g. "Pending", "Running", "Completed"). */
  Status?: string;
}
