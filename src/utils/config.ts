// Configuration Utility
// Handles loading configuration from environment variables and MCP client arguments.
// Supports gateway mode where credentials come via HTTP request headers.

import { McpServerConfig } from '../types/index.js';
import { LogLevel } from './logger.js';

export type TransportType = 'stdio' | 'http';
export type AuthMode = 'env' | 'gateway';

/**
 * Fully-resolved environment configuration for the CIPP MCP server.
 * Populated by {@link loadEnvironmentConfig} and consumed by the server
 * bootstrap and the CIPP API client.
 */
export interface EnvironmentConfig {
  /** CIPP API connection details read from the environment. */
  cipp: {
    /** Base URL of the CIPP Azure Function App. */
    baseUrl?: string;
    /** Static Bearer token used to authenticate requests to CIPP. */
    apiKey?: string;
    /** Entra tenant ID for OAuth client-credentials flow. */
    tenantId?: string;
    /** App registration client ID for OAuth client-credentials flow. */
    clientId?: string;
    /** App registration client secret for OAuth client-credentials flow. */
    clientSecret?: string;
    /** Optional OAuth scope override. */
    tokenScope?: string;
    /** Optional token endpoint URL override. */
    tokenUrl?: string;
  };
  /** Identity information surfaced to connected MCP clients. */
  server: {
    name: string;
    version: string;
  };
  /** Transport layer settings. */
  transport: {
    /** Whether to use stdio (default) or HTTP transport. */
    type: TransportType;
    /** TCP port for the HTTP transport listener. */
    port: number;
    /** Bind address for the HTTP transport listener. */
    host: string;
  };
  /** Logging configuration. */
  logging: {
    level: LogLevel;
    format: 'json' | 'simple';
  };
  /** Authentication mode that controls how credentials are sourced. */
  auth: {
    mode: AuthMode;
  };
}

/**
 * CIPP credentials as extracted from either gateway-injected environment
 * variables or per-request HTTP headers.
 */
export interface GatewayCredentials {
  /** CIPP base URL. Maps from the `X_BASE_URL` env var or `x-base-url` header. */
  baseUrl: string | undefined;
  /** CIPP API key / Bearer token. Maps from the `X_API_KEY` env var or `x-api-key` header. */
  apiKey: string | undefined;
  /** Entra tenant ID. Maps from `X_TENANT_ID` / `x-tenant-id`. */
  tenantId: string | undefined;
  /** OAuth client ID. Maps from `X_CLIENT_ID` / `x-client-id`. */
  clientId: string | undefined;
  /** OAuth client secret. Maps from `X_CLIENT_SECRET` / `x-client-secret`. */
  clientSecret: string | undefined;
  /** Optional OAuth scope override. Maps from `X_TOKEN_SCOPE` / `x-token-scope`. */
  tokenScope: string | undefined;
  /** Optional token endpoint URL override. Maps from `X_TOKEN_URL` / `x-token-url`. */
  tokenUrl: string | undefined;
}

// An unresolved MCPB/DXT manifest placeholder, e.g. "${user_config.cipp_api_key}".
// Desktop hosts (Claude Desktop) inject the config template verbatim when its
// optional user_config field is left blank, so the literal string arrives in the
// env var / header rather than an empty value or an omitted key.
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Normalise a single credential read from an env var or gateway header.
 *
 * Returns `undefined` for values that are effectively absent, so the auth layer
 * treats them as "no credential" rather than a real secret:
 *   - undefined / empty / whitespace-only
 *   - an unresolved manifest placeholder like `${user_config.cipp_api_key}`
 *
 * Root cause of the itglue-mcp #73 pattern: CIPP supports two auth modes — a
 * static Bearer API key OR OAuth client-credentials. A user configuring OAuth
 * leaves the optional API-key field blank, which leaves the literal
 * `${user_config.cipp_api_key}` in `CIPP_API_KEY`. Because that string is
 * truthy, `CippService` (see the `if (!apiKey && tenantId && clientId &&
 * clientSecret)` guard) never builds the OAuth `TokenProvider` and instead
 * sends `Authorization: Bearer ${user_config.cipp_api_key}` on every request —
 * a guaranteed 401. Stripping the placeholder here lets the OAuth path engage.
 */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Sanitise every field of a credential set at ingress, dropping empty and
 * unresolved-placeholder values. Applied to all credential sources (gateway env
 * vars, HTTP headers, and direct env reads) so a placeholder never reaches the
 * auth layer as a secret.
 */
export function sanitizeCredentials(creds: GatewayCredentials): GatewayCredentials {
  return {
    apiKey: cleanCredential(creds.apiKey),
    baseUrl: cleanCredential(creds.baseUrl),
    tenantId: cleanCredential(creds.tenantId),
    clientId: cleanCredential(creds.clientId),
    clientSecret: cleanCredential(creds.clientSecret),
    tokenScope: cleanCredential(creds.tokenScope),
    tokenUrl: cleanCredential(creds.tokenUrl),
  };
}

/**
 * Extract CIPP credentials from gateway-injected environment variables.
 *
 * When the MCP Gateway proxies a request it promotes HTTP headers to env vars:
 * - `X-Api-Key` header  →  `X_API_KEY` env var  (falls back to `CIPP_API_KEY`)
 * - `X-Base-Url` header →  `X_BASE_URL` env var (falls back to `CIPP_BASE_URL`)
 */
export function getCredentialsFromGateway(): GatewayCredentials {
  return sanitizeCredentials({
    apiKey: process.env.X_API_KEY || process.env.CIPP_API_KEY,
    baseUrl: process.env.X_BASE_URL || process.env.CIPP_BASE_URL,
    tenantId: process.env.X_TENANT_ID || process.env.CIPP_TENANT_ID,
    clientId: process.env.X_CLIENT_ID || process.env.CIPP_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET || process.env.CIPP_CLIENT_SECRET,
    tokenScope: process.env.X_TOKEN_SCOPE || process.env.CIPP_TOKEN_SCOPE,
    tokenUrl: process.env.X_TOKEN_URL || process.env.CIPP_TOKEN_URL,
  });
}

/**
 * Parse CIPP credentials from raw HTTP request headers.
 *
 * Expected headers (case-insensitive, hyphen-separated):
 * - `x-api-key`   – CIPP Bearer token
 * - `x-base-url`  – CIPP base URL
 *
 * @param headers - The incoming request headers object (e.g. from Node's `IncomingMessage`).
 */
export function parseCredentialsFromHeaders(
  headers: Record<string, string | string[] | undefined>
): GatewayCredentials {
  const getHeader = (name: string): string | undefined => {
    const value = headers[name] || headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  return sanitizeCredentials({
    apiKey: getHeader('x-api-key'),
    baseUrl: getHeader('x-base-url'),
    tenantId: getHeader('x-tenant-id'),
    clientId: getHeader('x-client-id'),
    clientSecret: getHeader('x-client-secret'),
    tokenScope: getHeader('x-token-scope'),
    tokenUrl: getHeader('x-token-url'),
  });
}

/**
 * Load and validate the full server configuration from environment variables.
 *
 * Recognised environment variables:
 * | Variable            | Description                                         | Default          |
 * |---------------------|-----------------------------------------------------|------------------|
 * | `CIPP_BASE_URL`     | Base URL of the CIPP Azure Function App             | –                |
 * | `CIPP_API_KEY`      | Static Bearer token for CIPP API (alt: OAuth below) | –                |
 * | `CIPP_TENANT_ID`    | Entra tenant ID (OAuth client-credentials flow)     | –                |
 * | `CIPP_CLIENT_ID`    | OAuth client ID of the CIPP API-client app reg      | –                |
 * | `CIPP_CLIENT_SECRET`| OAuth client secret                                 | –                |
 * | `CIPP_TOKEN_SCOPE`  | Override OAuth scope                                | `<clientId>/.default` |
 * | `CIPP_TOKEN_URL`    | Override OAuth token endpoint URL                   | Entra v2.0       |
 * | `AUTH_MODE`         | `env` (default) or `gateway`                        | `env`            |
 * | `MCP_TRANSPORT`     | `stdio` (default) or `http`                         | `stdio`          |
 * | `MCP_HTTP_PORT`     | TCP port for the HTTP transport                     | `8080`           |
 * | `MCP_HTTP_HOST`     | Bind address for the HTTP transport                 | `0.0.0.0`        |
 * | `MCP_SERVER_NAME`   | Server name surfaced to MCP clients                 | `cipp-mcp`       |
 * | `MCP_SERVER_VERSION`| Server version surfaced to MCP clients              | `1.0.0`          |
 * | `LOG_LEVEL`         | Winston log level (`error`/`warn`/`info`/`debug`)   | `info`           |
 * | `LOG_FORMAT`        | Log output format (`json` or `simple`)              | `simple`         |
 *
 * @throws {Error} If `MCP_TRANSPORT` is set to an unsupported value.
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  const authMode = (process.env.AUTH_MODE as AuthMode) || 'env';

  // In gateway mode the X_* env vars (injected by the gateway) take precedence.
  // In env mode we read the CIPP_* vars directly. getCredentialsFromGateway()
  // falls back to CIPP_* vars internally, so it is safe to call in both modes.
  const creds: GatewayCredentials = authMode === 'gateway'
    ? getCredentialsFromGateway()
    : sanitizeCredentials({
        apiKey: process.env.CIPP_API_KEY,
        baseUrl: process.env.CIPP_BASE_URL,
        tenantId: process.env.CIPP_TENANT_ID,
        clientId: process.env.CIPP_CLIENT_ID,
        clientSecret: process.env.CIPP_CLIENT_SECRET,
        tokenScope: process.env.CIPP_TOKEN_SCOPE,
        tokenUrl: process.env.CIPP_TOKEN_URL,
      });

  // Build the cipp sub-object, omitting undefined values so that
  // exactOptionalPropertyTypes is satisfied in strict tsconfig setups.
  const cippConfig: EnvironmentConfig['cipp'] = {};
  if (creds.baseUrl) cippConfig.baseUrl = creds.baseUrl;
  if (creds.apiKey) cippConfig.apiKey = creds.apiKey;
  if (creds.tenantId) cippConfig.tenantId = creds.tenantId;
  if (creds.clientId) cippConfig.clientId = creds.clientId;
  if (creds.clientSecret) cippConfig.clientSecret = creds.clientSecret;
  if (creds.tokenScope) cippConfig.tokenScope = creds.tokenScope;
  if (creds.tokenUrl) cippConfig.tokenUrl = creds.tokenUrl;

  const transportType = (process.env.MCP_TRANSPORT as TransportType) || 'stdio';
  if (transportType !== 'stdio' && transportType !== 'http') {
    throw new Error(
      `Invalid MCP_TRANSPORT value: "${transportType}". Must be "stdio" or "http".`
    );
  }

  return {
    cipp: cippConfig,
    server: {
      name: process.env.MCP_SERVER_NAME || 'cipp-mcp',
      version: process.env.MCP_SERVER_VERSION || '1.0.0',
    },
    transport: {
      type: transportType,
      port: parseInt(process.env.MCP_HTTP_PORT || '8080', 10),
      host: process.env.MCP_HTTP_HOST || '0.0.0.0',
    },
    logging: {
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      format: (process.env.LOG_FORMAT as 'json' | 'simple') || 'simple',
    },
    auth: {
      mode: authMode,
    },
  };
}

/**
 * Merge an {@link EnvironmentConfig} with optional MCP client arguments to
 * produce the final {@link McpServerConfig}.
 *
 * MCP client arguments (supplied via the MCP `initialize` handshake) override
 * the corresponding environment-derived values, allowing the same server
 * binary to serve multiple tenants without restart.
 *
 * @param envConfig - Config loaded via {@link loadEnvironmentConfig}.
 * @param mcpArgs   - Optional key/value map from the MCP client's init arguments.
 */
export function mergeWithMcpConfig(
  envConfig: EnvironmentConfig,
  mcpArgs?: Record<string, any>
): McpServerConfig {
  return {
    name: mcpArgs?.name || envConfig.server.name,
    version: mcpArgs?.version || envConfig.server.version,
    cipp: {
      baseUrl: mcpArgs?.cipp?.baseUrl || envConfig.cipp.baseUrl,
      apiKey: mcpArgs?.cipp?.apiKey || envConfig.cipp.apiKey,
      tenantId: mcpArgs?.cipp?.tenantId || envConfig.cipp.tenantId,
      clientId: mcpArgs?.cipp?.clientId || envConfig.cipp.clientId,
      clientSecret: mcpArgs?.cipp?.clientSecret || envConfig.cipp.clientSecret,
      tokenScope: mcpArgs?.cipp?.tokenScope || envConfig.cipp.tokenScope,
      tokenUrl: mcpArgs?.cipp?.tokenUrl || envConfig.cipp.tokenUrl,
    },
  };
}
