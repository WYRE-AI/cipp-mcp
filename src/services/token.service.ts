// OAuth token provider for the CIPP API.
//
// CIPP's API clients (Settings → Integrations → CIPP-API) are Entra app
// registrations. Callers authenticate via the OAuth 2.0 client-credentials
// flow and pass the resulting access token as a Bearer to /api/*.
//
// This provider performs that exchange and caches tokens until just before
// their expiry, so the MCP server can simply ask for a fresh token on each
// request without hammering the /oauth2/v2.0/token endpoint.

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '../utils/logger.js';

/** Credentials needed to run the client-credentials flow against Entra ID. */
export interface TokenProviderConfig {
  /** Entra tenant (directory) ID that owns the API-client app registration. */
  tenantId: string;
  /** Application (client) ID of the CIPP API client. */
  clientId: string;
  /** Application secret value issued for the CIPP API client. */
  clientSecret: string;
  /**
   * OAuth scope to request. When set, this value is sent as-is and the
   * legacy-scope fallback is disabled. When omitted, the scope defaults to
   * `api://<clientId>/.default` — the Application ID URI CIPP App Service
   * authentication allows. A token minted for the bare `<clientId>/.default`
   * has `aud` set to the GUID, which that auth layer rejects with HTTP 401.
   */
  scope?: string;
  /**
   * When no explicit scope is set, a CIPP HTTP 401 is retried once with the
   * other automatic audience (`api://<clientId>/.default` or the legacy
   * `<clientId>/.default`). The audience that succeeds is remembered, and a
   * later 401 tries the other one once. Defaults to enabled. Set false via
   * `CIPP_TOKEN_SCOPE_FALLBACK` / `TOKEN_SCOPE_FALLBACK` or the
   * `x-token-scope-fallback` header.
   */
  scopeFallback?: boolean;
  /**
   * Full token endpoint URL. Defaults to
   * `https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/token`.
   * Override only to target sovereign clouds or a custom STS.
   */
  tokenUrl?: string;
}

/**
 * Audience CIPP's App Service authentication allows. Entra sets `aud` to
 * `api://<clientId>` when the token is requested with this scope.
 */
export function apiDefaultScope(clientId: string): string {
  return `api://${clientId}/.default`;
}

/**
 * Legacy audience. Entra sets `aud` to the bare client id. Kept so a CIPP
 * deployment that still allows only that audience keeps working.
 */
export function legacyDefaultScope(clientId: string): string {
  return `${clientId}/.default`;
}

interface CachedToken {
  /** Scope this access token was minted for. A different scope must not reuse it. */
  scope: string;
  accessToken: string;
  /** Epoch milliseconds at which the token should be considered expired. */
  expiresAt: number;
}

/**
 * Scope that CIPP accepted, keyed by tenant + client id.
 *
 * Gateway mode builds a new {@link TokenProvider} per request, so the memory
 * of which audience worked has to outlive a single instance. An explicit
 * scope never reads or writes this map.
 */
const pinnedScopes = new Map<string, string>();

/** Refresh tokens this many milliseconds before their nominal expiry. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Acquires and caches CIPP API access tokens via the Entra ID
 * client-credentials flow.
 */
export class TokenProvider {
  private readonly config: Required<Pick<TokenProviderConfig, 'tenantId' | 'clientId' | 'clientSecret'>> &
    Pick<TokenProviderConfig, 'scope' | 'tokenUrl' | 'scopeFallback'>;
  private readonly logger: Logger;
  /** Set only when the caller passed a scope. Presence — not the value — disables fallback. */
  private readonly explicitScope: string | undefined;
  private readonly scopeFallback: boolean;
  private readonly clientKey: string;
  private cache: CachedToken | undefined;
  /** In-flight mints keyed by scope, so an api:// fetch cannot satisfy a legacy retry. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(config: TokenProviderConfig, logger: Logger) {
    if (!config.tenantId) {
      throw new Error('TokenProvider: tenantId is required');
    }
    if (!config.clientId) {
      throw new Error('TokenProvider: clientId is required');
    }
    if (!config.clientSecret) {
      throw new Error('TokenProvider: clientSecret is required');
    }
    this.config = config;
    this.logger = logger;
    const trimmedScope = config.scope?.trim();
    this.explicitScope = trimmedScope ? trimmedScope : undefined;
    this.scopeFallback = config.scopeFallback !== false;
    this.clientKey = `${config.tenantId}\n${config.clientId}`;
  }

  /**
   * Drop every remembered audience. Tests use this so suites do not share a
   * process-wide pin; nothing in the request path calls it.
   */
  static clearPinnedScopes(): void {
    pinnedScopes.clear();
  }

  /** Scope the next ordinary token request will use. */
  get activeScope(): string {
    if (this.explicitScope !== undefined) return this.explicitScope;
    if (this.scopeFallback) {
      const pinned = pinnedScopes.get(this.clientKey);
      if (pinned) return pinned;
    }
    return apiDefaultScope(this.config.clientId);
  }

  /** Bare-GUID scope `<clientId>/.default`, used for the single 401 retry. */
  get legacyScope(): string {
    return legacyDefaultScope(this.config.clientId);
  }

  /**
   * The other automatic audience to try after a CIPP 401 on `rejectedScope`,
   * or `undefined` when a retry must not happen (an explicit scope was
   * configured, or fallback is disabled).
   *
   * `rejectedScope` is the audience of the token that CIPP just refused. It
   * must be the value captured for that send: reading {@link activeScope}
   * here would race with another request pinning a different audience while
   * this one is still waiting on its 401, and the retry would repeat the
   * audience that already failed. Callers retry once with this value.
   */
  alternateScope(rejectedScope: string): string | undefined {
    if (this.explicitScope !== undefined) return undefined;
    if (!this.scopeFallback) return undefined;
    const apiScope = apiDefaultScope(this.config.clientId);
    if (rejectedScope === this.legacyScope) return apiScope;
    if (rejectedScope === apiScope) return this.legacyScope;
    return undefined;
  }

  /**
   * Remember the scope CIPP accepted for this client so later calls mint it
   * directly. Explicit scopes and a disabled fallback never write the pin.
   */
  pinSuccessfulScope(scope: string): void {
    if (this.explicitScope !== undefined || !this.scopeFallback) return;
    pinnedScopes.set(this.clientKey, scope);
  }

  /**
   * Forget the audience remembered for this client. A 401 on the pinned
   * scope clears it before the one alternate retry, so a CIPP that changes
   * which audience it allows is not stuck until process restart.
   */
  clearPinnedScope(): void {
    if (this.explicitScope !== undefined || !this.scopeFallback) return;
    pinnedScopes.delete(this.clientKey);
  }

  /**
   * Return a valid access token, acquiring or refreshing as needed.
   * Concurrent callers for the same scope share one in-flight request.
   *
   * Pass `scope` to mint that audience even if another request changes the
   * pin while this call is in flight. Omitted means {@link activeScope} at
   * the moment of the call.
   */
  async getAccessToken(scope?: string): Promise<string> {
    return this.tokenFor(scope ?? this.activeScope);
  }

  /**
   * Mint (or reuse) a token for `scope`, ignoring the active scope.
   * Used for the one legacy-scope retry. Does not pin; the caller pins only
   * after CIPP accepts the token.
   */
  async getAccessTokenForScope(scope: string): Promise<string> {
    return this.tokenFor(scope);
  }

  private async tokenFor(scope: string): Promise<string> {
    const now = Date.now();
    if (this.cache && this.cache.scope === scope && now < this.cache.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return this.cache.accessToken;
    }
    const existing = this.inflight.get(scope);
    if (existing) return existing;
    const pending = this.fetchToken(scope).finally(() => {
      this.inflight.delete(scope);
    });
    this.inflight.set(scope, pending);
    return pending;
  }

  private get tokenUrl(): string {
    return (
      this.config.tokenUrl ||
      `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`
    );
  }

  private async fetchToken(scope: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope,
    });

    this.logger.debug('Requesting CIPP access token', {
      tokenUrl: this.tokenUrl,
      scope,
      clientId: this.config.clientId,
    });

    let response: Response;
    try {
      response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(
        ErrorCode.InternalError,
        `Network error obtaining CIPP access token from ${this.tokenUrl}: ${message}`
      );
    }

    const rawBody = await response.text();
    if (!response.ok) {
      this.logger.error('CIPP token endpoint returned error', {
        status: response.status,
        body: rawBody,
      });
      throw new McpError(
        ErrorCode.InternalError,
        `CIPP token endpoint returned HTTP ${response.status}: ${rawBody}`
      );
    }

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(rawBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to parse CIPP token response as JSON: ${message}`
      );
    }

    if (!parsed.access_token) {
      throw new McpError(
        ErrorCode.InternalError,
        'CIPP token response did not include an access_token field'
      );
    }

    const expiresInMs = (parsed.expires_in ?? 3600) * 1000;
    this.cache = {
      scope,
      accessToken: parsed.access_token,
      expiresAt: Date.now() + expiresInMs,
    };
    this.logger.debug('CIPP access token cached', {
      expiresInSeconds: parsed.expires_in,
    });
    return parsed.access_token;
  }
}
