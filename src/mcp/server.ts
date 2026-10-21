// CIPP MCP Server
// Handles the Model Context Protocol server setup and integration with CIPP.
// Supports both local (env-based) and gateway (header-based) credential modes.

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../services/cipp.service.js';
import { Logger } from '../utils/logger.js';
import { McpServerConfig } from '../types/index.js';
import { EnvironmentConfig, parseCredentialsFromHeaders } from '../utils/config.js';
import { CippToolHandler } from '../handlers/tool.handler.js';
import { verifyS2sHeader, S2S_HEADER } from '../s2s-verify.js';

// Conduit service-to-service auth (gateway#377 parity). Read when the HTTP
// transport starts, not at import. An empty CONDUIT_S2S_SECRET refuses to
// listen unless MCP_ALLOW_INSECURE_DEV=1, and that bypass binds 127.0.0.1
// only. A known placeholder is never a secret. See src/s2s-verify.ts.

/** Bind used when MCP_HTTP_HOST is unset, and the only bind the insecure-dev bypass allows. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, and MCP_ALLOW_INSECURE_DEV does not turn one into a bypass.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

// Unresolved MCPB/DXT manifest placeholder, same shape config.ts rejects for
// CIPP credentials (for example "${user_config.conduit_s2s_secret}").
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is not enforcing X-Gateway-S2S and listens on 127.0.0.1 only. ' +
  'Do not use this outside local development.';

function isKnownPlaceholderSecret(secret: string): boolean {
  return CONFIG_PLACEHOLDER.test(secret) || KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase());
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Secret for X-Gateway-S2S on /mcp. Empty is fail-closed: the process exits
 * unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder always exits. The
 * secret value is never written to logs.
 */
function resolveHttpS2sSecret(logger: Logger): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (secret && isKnownPlaceholderSecret(secret)) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return '';
  }

  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (the insecure-dev bypass) always binds 127.0.0.1, including when
 * MCP_HTTP_HOST is a wider address such as 0.0.0.0. A configured secret
 * honors MCP_HTTP_HOST, and defaults to 127.0.0.1 when that variable is unset.
 */
function resolveListenHost(s2sSecret: string, logger: Logger): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

export class CippMcpServer {
  private server: Server;
  private config: McpServerConfig;
  private cippService: CippService;
  private toolHandler: CippToolHandler;
  private logger: Logger;
  private envConfig: EnvironmentConfig | undefined;
  private httpServer?: HttpServer;

  constructor(config: McpServerConfig, logger: Logger, envConfig?: EnvironmentConfig) {
    this.logger = logger;
    this.config = config;
    this.envConfig = envConfig;

    this.cippService = new CippService(config, logger);
    this.toolHandler = new CippToolHandler(this.cippService, logger);

    this.server = this.createFreshServer();
  }

  /**
   * Create a fresh MCP Server with all handlers registered.
   * Called per-request in HTTP (stateless) mode so each initialise gets a clean server.
   */
  private createFreshServer(): Server {
    const server = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
        instructions: this.getServerInstructions(),
      }
    );

    server.onerror = (error) => {
      this.logger.error('MCP Server error:', error);
    };

    server.oninitialized = () => {
      this.logger.info('MCP Server initialized and ready to serve requests');
    };

    this.setupHandlers(server);
    this.toolHandler.setServer(server);

    return server;
  }

  /**
   * Returns instructions that help MCP clients understand how to use this server.
   */
  private getServerInstructions(): string {
    return `
CIPP MCP Server — M365 multi-tenant management platform for MSPs.

Use tenantFilter to scope operations to a specific tenant domain (e.g. "contoso.com").
Most listing tools accept 'allTenants' as tenantFilter to query across every managed tenant.

Always confirm destructive operations (disable user, offboard user, reset password) before executing.

Tool categories:
- Tenants: list and inspect managed tenants
- Users: list, create, edit, disable, offboard, MFA/session management, BEC check
- Groups: list and create Azure AD groups
- Mailboxes: list mailboxes and permissions, configure OoO and forwarding
- Security: Conditional Access policies, named locations, Microsoft Secure Score (one tenant; allTenants is rejected)
- Standards: compliance standards, BPA results, domain health
- Licenses: per-tenant and CSP-level license reporting
- Alerts: audit logs and alert queue
- GDAP: roles and relationship invites
- Scheduler: list and create scheduled tasks
- Core: ping, version, logs
`.trim();
  }

  /**
   * Register all MCP request handlers on the given server instance.
   */
  private setupHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Handling list tools request');
      return { tools: this.toolHandler.getToolDefinitions() };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logger.debug(`Handling tool call: ${request.params.name}`);
      try {
        const result = await this.toolHandler.handleToolCall(
          request.params.name,
          (request.params.arguments as Record<string, unknown>) || {}
        );
        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        this.logger.error(`Failed to call tool ${request.params.name}:`, error);
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
        };
      }
    });

  }

  /**
   * Start the server using the configured transport type.
   */
  async start(): Promise<void> {
    const transportType = this.envConfig?.transport?.type || 'stdio';
    this.logger.info(`Starting CIPP MCP Server with ${transportType} transport...`);

    if (transportType === 'http') {
      await this.startHttpTransport();
    } else {
      await this.startStdioTransport();
    }
  }

  private async startStdioTransport(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('CIPP MCP Server started on stdio transport');
  }

  private async startHttpTransport(): Promise<void> {
    // Port 0 (ephemeral) is a real bind. `||` would treat it as unset.
    const configuredPort = this.envConfig?.transport?.port;
    const port =
      typeof configuredPort === 'number' && Number.isFinite(configuredPort) ? configuredPort : 8080;
    const s2sSecret = resolveHttpS2sSecret(this.logger);
    const host = resolveListenHost(s2sSecret, this.logger);
    const isGatewayMode = this.envConfig?.auth?.mode === 'gateway';

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname === '/mcp') {
        // Conduit service-to-service auth (gateway#377 parity): rejected
        // BEFORE any credential extraction (OAuth or static key), mirroring
        // every other ported wrapper (e.g.
        // containers/sentinelone-mcp/gateway_wrapper.py). An empty secret
        // only reaches this point when MCP_ALLOW_INSECURE_DEV=1.
        if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
            })
          );
          return;
        }

        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Method not allowed' },
              id: null,
            })
          );
          return;
        }

        let toolHandler = this.toolHandler;

        if (isGatewayMode) {
          // Credentials must arrive on this request. Falling through would
          // use the process-level CippService and its CIPP_* env credentials,
          // which are not request-scoped (CWE-306).
          const credentials = parseCredentialsFromHeaders(
            req.headers as Record<string, string | string[] | undefined>
          );

          const hasOAuth =
            !!credentials.tenantId && !!credentials.clientId && !!credentials.clientSecret;
          const hasStatic = !!credentials.apiKey;

          if (!credentials.baseUrl || (!hasStatic && !hasOAuth)) {
            this.logger.warn('Gateway mode: Missing required credentials in request headers', {
              hasBaseUrl: !!credentials.baseUrl,
              hasApiKey: hasStatic,
              hasOAuthCreds: hasOAuth,
            });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Missing credentials',
                message:
                  'Gateway mode requires x-base-url plus either x-api-key or (x-tenant-id + x-client-id + x-client-secret)',
                required: ['x-base-url', 'x-api-key OR (x-tenant-id + x-client-id + x-client-secret)'],
              })
            );
            return;
          }

          // Header wins; otherwise the process env (default on). `??` keeps an explicit false.
          const tokenScopeFallback =
            credentials.tokenScopeFallback ?? this.envConfig?.cipp.tokenScopeFallback;

          const requestConfig: McpServerConfig = {
            name: this.config.name,
            version: this.config.version,
            cipp: {
              baseUrl: credentials.baseUrl,
              ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
              ...(credentials.tenantId !== undefined ? { tenantId: credentials.tenantId } : {}),
              ...(credentials.clientId !== undefined ? { clientId: credentials.clientId } : {}),
              ...(credentials.clientSecret !== undefined ? { clientSecret: credentials.clientSecret } : {}),
              ...(credentials.tokenScope !== undefined ? { tokenScope: credentials.tokenScope } : {}),
              ...(credentials.tokenUrl !== undefined ? { tokenUrl: credentials.tokenUrl } : {}),
              ...(tokenScopeFallback !== undefined ? { tokenScopeFallback } : {}),
            },
          };

          const cippService = new CippService(requestConfig, this.logger);
          toolHandler = new CippToolHandler(cippService, this.logger);
        }

        const server = new Server(
          { name: this.config.name, version: this.config.version },
          {
            capabilities: { tools: { listChanged: true } },
            instructions: this.getServerInstructions(),
          }
        );

        server.onerror = (error) => this.logger.error('MCP request server error:', error);

        // Wire up handlers using the (possibly per-request) toolHandler
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: toolHandler.getToolDefinitions(),
        }));

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          this.logger.debug(`Handling tool call: ${request.params.name}`);
          try {
            const result = await toolHandler.handleToolCall(
              request.params.name,
              (request.params.arguments as Record<string, unknown>) || {}
            );
            return { content: result.content, isError: result.isError };
          } catch (error) {
            this.logger.error(`Failed to call tool ${request.params.name}:`, error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            return {
              content: [{ type: 'text', text: message }],
              isError: true,
            };
          }
        });

        toolHandler.setServer(server);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on('close', () => {
          transport.close();
          server.close();
        });

        server
          .connect(transport as any)
          .then(() => {
            transport.handleRequest(req, res);
          })
          .catch((err) => {
            this.logger.error('MCP transport connect error:', err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: { code: -32603, message: 'Internal error' },
                  id: null,
                })
              );
            }
          });

        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        this.logger.info(`CIPP MCP Server listening on http://${host}:${port}/mcp`);
        this.logger.info(`Health check available at http://${host}:${port}/health`);
        this.logger.info(
          `Authentication mode: ${isGatewayMode ? 'gateway (header-based)' : 'env (environment variables)'}`
        );
        resolve();
      });
    });
  }

  /**
   * TCP address the HTTP transport bound, once {@link start} has listened.
   */
  httpAddress(): AddressInfo | null {
    const address = this.httpServer?.address() ?? null;
    if (!address || typeof address === 'string') return null;
    return address;
  }

  /**
   * Gracefully stop the server.
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping CIPP MCP Server...');
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await this.server.close();
    this.logger.info('CIPP MCP Server stopped');
  }
}
