// CIPP Tool Handler
// Dispatches MCP tool calls to the correct CippService method.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { CippService } from '../services/cipp.service.js';
import { Logger } from '../utils/logger.js';
import { TOOL_DEFINITIONS } from '../mcp/tool.definitions.js';

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class CippToolHandler {
  private cippService: CippService;
  private logger: Logger;
  private mcpServer: Server | null = null;

  constructor(cippService: CippService, logger: Logger) {
    this.cippService = cippService;
    this.logger = logger;
  }

  setServer(server: Server): void {
    this.mcpServer = server;
  }

  getServer(): Server | null {
    return this.mcpServer;
  }

  getToolDefinitions() {
    return TOOL_DEFINITIONS;
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.logger.debug(`Dispatching tool call: ${name}`, { args });

    try {
      let result: unknown;

      switch (name) {
        // -----------------------------------------------------------------------
        // Tenants
        // -----------------------------------------------------------------------
        case 'cipp_list_tenants': {
          const { allTenants } = args as { allTenants?: boolean };
          result = await this.cippService.listTenants({ allTenants });
          break;
        }

        case 'cipp_get_tenant_details': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.getTenantDetails(tenantFilter);
          break;
        }

        // -----------------------------------------------------------------------
        // Users
        // -----------------------------------------------------------------------
        case 'cipp_list_users': {
          const { tenantFilter, searchField, searchValue } = args as {
            tenantFilter: string;
            searchField?: string;
            searchValue?: string;
          };
          result = await this.cippService.listUsers(tenantFilter, { searchField, searchValue });
          break;
        }

        case 'cipp_create_user': {
          const {
            tenantFilter,
            displayName,
            userPrincipalName,
            password,
            givenName,
            surname,
            jobTitle,
            department,
            country,
          } = args as {
            tenantFilter: string;
            displayName: string;
            userPrincipalName: string;
            password: string;
            givenName?: string;
            surname?: string;
            jobTitle?: string;
            department?: string;
            country?: string;
          };
          const userData: Record<string, unknown> = {
            displayName,
            userPrincipalName,
            password,
          };
          if (givenName !== undefined) userData.givenName = givenName;
          if (surname !== undefined) userData.surname = surname;
          if (jobTitle !== undefined) userData.jobTitle = jobTitle;
          if (department !== undefined) userData.department = department;
          if (country !== undefined) userData.country = country;
          result = await this.cippService.createUser(tenantFilter, userData);
          break;
        }

        case 'cipp_edit_user': {
          const {
            tenantFilter,
            userId,
            displayName,
            jobTitle,
            department,
            usageLocation,
          } = args as {
            tenantFilter: string;
            userId: string;
            displayName?: string;
            jobTitle?: string;
            department?: string;
            usageLocation?: string;
          };
          const editData: Record<string, unknown> = {};
          if (displayName !== undefined) editData.displayName = displayName;
          if (jobTitle !== undefined) editData.jobTitle = jobTitle;
          if (department !== undefined) editData.department = department;
          if (usageLocation !== undefined) editData.usageLocation = usageLocation;
          result = await this.cippService.editUser(tenantFilter, userId, editData);
          break;
        }

        case 'cipp_disable_user': {
          const { tenantFilter, userId } = args as { tenantFilter: string; userId: string };
          result = await this.cippService.disableUser(tenantFilter, userId);
          break;
        }

        case 'cipp_reset_password': {
          const { tenantFilter, userId, newPassword } = args as {
            tenantFilter: string;
            userId: string;
            newPassword?: string;
          };
          result = await this.cippService.resetPassword(tenantFilter, userId, newPassword);
          break;
        }

        case 'cipp_reset_mfa': {
          const { tenantFilter, userId } = args as { tenantFilter: string; userId: string };
          result = await this.cippService.resetMFA(tenantFilter, userId);
          break;
        }

        case 'cipp_revoke_sessions': {
          const { tenantFilter, userId } = args as { tenantFilter: string; userId: string };
          result = await this.cippService.revokeSessions(tenantFilter, userId);
          break;
        }

        case 'cipp_offboard_user': {
          const {
            tenantFilter,
            userId,
            revokePermissions,
            disableUser,
            resetPassword,
            transferMailbox,
          } = args as {
            tenantFilter: string;
            userId: string;
            revokePermissions?: boolean;
            disableUser?: boolean;
            resetPassword?: boolean;
            transferMailbox?: string;
          };
          const offboardOptions: Record<string, unknown> = {};
          if (revokePermissions !== undefined) offboardOptions.revokePermissions = revokePermissions;
          if (disableUser !== undefined) offboardOptions.disableUser = disableUser;
          if (resetPassword !== undefined) offboardOptions.resetPassword = resetPassword;
          if (transferMailbox !== undefined) offboardOptions.transferMailbox = transferMailbox;
          result = await this.cippService.offboardUser(tenantFilter, userId, offboardOptions);
          break;
        }

        case 'cipp_bec_check': {
          const { tenantFilter, userId } = args as { tenantFilter: string; userId: string };
          result = await this.cippService.becCheck(tenantFilter, userId);
          break;
        }

        case 'cipp_list_mfa_users': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listMfaUsers(tenantFilter);
          break;
        }

        case 'cipp_list_user_devices': {
          const { tenantFilter, userId } = args as { tenantFilter: string; userId: string };
          result = await this.cippService.listUserDevices(tenantFilter, userId);
          break;
        }

        case 'cipp_list_user_groups': {
          const { tenantFilter, userId } = args as { tenantFilter: string; userId: string };
          result = await this.cippService.listUserGroups(tenantFilter, userId);
          break;
        }

        // -----------------------------------------------------------------------
        // Groups
        // -----------------------------------------------------------------------
        case 'cipp_list_groups': {
          const { tenantFilter, search } = args as { tenantFilter: string; search?: string };
          result = await this.cippService.listGroups(tenantFilter, { search });
          break;
        }

        case 'cipp_create_group': {
          const {
            tenantFilter,
            displayName,
            description,
            securityEnabled,
            mailEnabled,
            mailNickname,
          } = args as {
            tenantFilter: string;
            displayName: string;
            description?: string;
            securityEnabled?: boolean;
            mailEnabled?: boolean;
            mailNickname?: string;
          };
          const groupData: Record<string, unknown> = { displayName };
          if (description !== undefined) groupData.description = description;
          if (securityEnabled !== undefined) groupData.securityEnabled = securityEnabled;
          if (mailEnabled !== undefined) groupData.mailEnabled = mailEnabled;
          if (mailNickname !== undefined) groupData.mailNickname = mailNickname;
          result = await this.cippService.createGroup(tenantFilter, groupData);
          break;
        }

        // -----------------------------------------------------------------------
        // Mailboxes
        // -----------------------------------------------------------------------
        case 'cipp_list_mailboxes': {
          const { tenantFilter, type } = args as { tenantFilter: string; type?: string };
          result = await this.cippService.listMailboxes(tenantFilter, { type });
          break;
        }

        case 'cipp_list_mailbox_permissions': {
          const { tenantFilter, upn } = args as { tenantFilter: string; upn: string };
          result = await this.cippService.listMailboxPermissions(tenantFilter, upn);
          break;
        }

        case 'cipp_set_out_of_office': {
          const { tenantFilter, upn, enabled, internalMessage, externalMessage } = args as {
            tenantFilter: string;
            upn: string;
            enabled: boolean;
            internalMessage?: string;
            externalMessage?: string;
          };
          const oooData: Record<string, unknown> = { enabled };
          if (internalMessage !== undefined) oooData.internalMessage = internalMessage;
          if (externalMessage !== undefined) oooData.externalMessage = externalMessage;
          result = await this.cippService.setOutOfOffice(tenantFilter, upn, oooData);
          break;
        }

        case 'cipp_set_email_forwarding': {
          const { tenantFilter, upn, forwardTo, keepCopy } = args as {
            tenantFilter: string;
            upn: string;
            forwardTo?: string;
            keepCopy?: boolean;
          };
          const forwardData: Record<string, unknown> = {};
          if (forwardTo !== undefined) forwardData.forwardTo = forwardTo;
          if (keepCopy !== undefined) forwardData.keepCopy = keepCopy;
          result = await this.cippService.setEmailForwarding(tenantFilter, upn, forwardData);
          break;
        }

        // -----------------------------------------------------------------------
        // Security
        // -----------------------------------------------------------------------
        case 'cipp_list_conditional_access_policies': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listConditionalAccessPolicies(tenantFilter);
          break;
        }

        case 'cipp_list_named_locations': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listNamedLocations(tenantFilter);
          break;
        }

        // -----------------------------------------------------------------------
        // Standards
        // -----------------------------------------------------------------------
        case 'cipp_list_standards': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listStandards(tenantFilter);
          break;
        }

        case 'cipp_run_standards_check': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.runStandardsCheck(tenantFilter);
          break;
        }

        case 'cipp_list_standard_templates': {
          result = await this.cippService.listStandardTemplates();
          break;
        }

        // `tenantFilter` is optional for these two tools: omit it to report
        // across all tenants. This diverges intentionally from other Standards
        // cases that require it.
        case 'cipp_get_tenant_drift': {
          const { tenantFilter } = args as { tenantFilter?: string };
          result = await this.cippService.getTenantDrift(tenantFilter);
          break;
        }

        case 'cipp_get_tenant_alignment': {
          const { tenantFilter } = args as { tenantFilter?: string };
          result = await this.cippService.getTenantAlignment(tenantFilter);
          break;
        }

        case 'cipp_create_standard_template': {
          const { template } = args as { template: Record<string, unknown> };
          result = await this.cippService.createStandardTemplate(template);
          break;
        }

        case 'cipp_delete_standard_template': {
          const { templateId } = args as { templateId: string };
          result = await this.cippService.deleteStandardTemplate(templateId);
          break;
        }

        case 'cipp_list_bpa': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listBPA(tenantFilter);
          break;
        }

        case 'cipp_list_domain_health': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listDomainHealth(tenantFilter);
          break;
        }

        // -----------------------------------------------------------------------
        // Licenses
        // -----------------------------------------------------------------------
        case 'cipp_list_licenses': {
          const { tenantFilter } = args as { tenantFilter: string };
          result = await this.cippService.listLicenses(tenantFilter);
          break;
        }

        case 'cipp_list_csp_licenses': {
          result = await this.cippService.listCSPLicenses();
          break;
        }

        // -----------------------------------------------------------------------
        // Alerts
        // -----------------------------------------------------------------------
        case 'cipp_list_audit_logs': {
          const { tenantFilter, days, type } = args as {
            tenantFilter: string;
            days?: number;
            type?: string;
          };
          result = await this.cippService.listAuditLogs(tenantFilter, {
            Days: days,
            Type: type,
          });
          break;
        }

        case 'cipp_list_alert_queue': {
          result = await this.cippService.listAlertQueue();
          break;
        }

        // -----------------------------------------------------------------------
        // GDAP
        // -----------------------------------------------------------------------
        case 'cipp_list_gdap_roles': {
          result = await this.cippService.listGDAPRoles();
          break;
        }

        case 'cipp_list_gdap_invites': {
          result = await this.cippService.listGDAPInvites();
          break;
        }

        // -----------------------------------------------------------------------
        // Scheduler
        // -----------------------------------------------------------------------
        case 'cipp_list_scheduled_items': {
          result = await this.cippService.listScheduledItems();
          break;
        }

        case 'cipp_add_scheduled_item': {
          const { taskName, command, scheduledTime, recurrence, tenantFilter } = args as {
            taskName: string;
            command: string;
            scheduledTime: string;
            recurrence?: string;
            tenantFilter?: string;
          };
          const itemData: Record<string, unknown> = {
            taskName,
            command,
            scheduledTime,
          };
          if (recurrence !== undefined) itemData.recurrence = recurrence;
          if (tenantFilter !== undefined) itemData.tenantFilter = tenantFilter;
          result = await this.cippService.addScheduledItem(itemData);
          break;
        }

        // -----------------------------------------------------------------------
        // Core
        // -----------------------------------------------------------------------
        case 'cipp_ping': {
          result = await this.cippService.ping();
          break;
        }

        case 'cipp_get_version': {
          result = await this.cippService.getVersion();
          break;
        }

        case 'cipp_list_logs': {
          const { dateFilter } = args as { dateFilter?: string };
          result = await this.cippService.listLogs(
            dateFilter !== undefined ? { DateFilter: dateFilter } : undefined
          );
          break;
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Tool call failed: ${name}`, { error: message });
      throw new McpError(ErrorCode.InternalError, `Tool ${name} failed: ${message}`);
    }
  }
}
