// CIPP API Service
// Wraps all HTTP calls to the CIPP Azure Function App.
// All endpoints live at {baseUrl}/api/{FunctionName} and are authenticated
// with a Bearer token supplied in the Authorization header.

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';
import { TokenProvider } from './token.service.js';

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
   * @param tenantFilter - Tenant domain or identifier.
   * @param params       - Optional search parameters.
   * @param params.searchField - Azure AD attribute to search on (e.g. `displayName`).
   * @param params.searchValue - Value to match against the search field.
   */
  async listUsers<T = unknown>(
    tenantFilter: string,
    params?: { searchField?: string; searchValue?: string }
  ): Promise<T> {
    return this.request<T>('GET', 'ListUsers', {
      tenantFilter,
      ...params,
    });
  }

  /**
   * Create a new user in a tenant.
   * Calls the `AddUser` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userData     - User properties to set (displayName, UPN, password, etc.).
   */
  async createUser<T = unknown>(
    tenantFilter: string,
    userData: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>('POST', 'AddUser', undefined, { tenantFilter, ...userData });
  }

  /**
   * Update properties of an existing user.
   * Calls the `EditUser` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user to update.
   * @param userData     - User properties to update.
   */
  async editUser<T = unknown>(
    tenantFilter: string,
    userId: string,
    userData: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>('PATCH', 'EditUser', undefined, {
      tenantFilter,
      id: userId,
      ...userData,
    });
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
   * Offboard a user, optionally applying additional cleanup actions.
   * Calls the `ExecOffboardUser` Azure Function.
   *
   * @param tenantFilter - Tenant domain or identifier.
   * @param userId       - Azure AD object ID of the user to offboard.
   * @param options      - Optional offboarding actions (e.g. revokeSession, deleteUser).
   */
  async offboardUser<T = unknown>(
    tenantFilter: string,
    userId: string,
    options?: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>('POST', 'ExecOffboardUser', undefined, {
      tenantFilter,
      ID: userId,
      ...options,
    });
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
    oooData: Record<string, unknown>
  ): Promise<T> {
    return this.request<T>('POST', 'ExecSetOoO', undefined, {
      tenantFilter,
      UserPrincipalName: upn,
      ...oooData,
    });
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
    return this.request<T>('POST', 'ExecEmailForward', undefined, {
      tenantFilter,
      UserPrincipalName: upn,
      ...forwardData,
    });
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
   * @param itemData - Scheduled item properties (name, recurrence, taskInfo, etc.).
   */
  async addScheduledItem<T = unknown>(itemData: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', 'AddScheduledItem', undefined, itemData);
  }
}
