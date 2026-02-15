/**
 * @fileoverview Get user's transaction accounts from PocketSmith
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import { PocketSmithService } from "../../../services/pocketsmith.js";
import { registerTool } from "./schemaHelpers.js";

export const GetTransactionAccountsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetTransactionAccountsInput = z.infer<typeof GetTransactionAccountsInputSchema>;

export const GetTransactionAccountsResponseSchema = z.object({
  transactionAccounts: z.array(z.object({
    id: z.number(),
    name: z.string(),
    number: z.string().nullable(),
    current_balance: z.number(),
    current_balance_date: z.string(),
    current_balance_in_base_currency: z.number(),
    safe_balance: z.number().nullable(),
    safe_balance_in_base_currency: z.number().nullable(),
    starting_balance: z.number(),
    starting_balance_date: z.string(),
    currency_code: z.string(),
    type: z.string(),
    institution: z.object({
      id: z.number(),
      title: z.string(),
    }).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })).describe("List of user's transaction accounts"),
  summary: z.object({
    totalAccounts: z.number(),
    totalBalance: z.number(),
    accountsByType: z.record(z.string(), z.number()),
  }).describe("Summary of transaction accounts"),
});

export type GetTransactionAccountsResponse = z.infer<typeof GetTransactionAccountsResponseSchema>;

export async function getTransactionAccountsLogic(
  params: GetTransactionAccountsInput,
  context: RequestContext,
): Promise<GetTransactionAccountsResponse> {
  logger.debug("Processing get transaction accounts request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get transaction accounts
  const transactionAccounts = await service.getTransactionAccounts(user.id!, context);

  // Process transaction accounts
  const processedAccounts = transactionAccounts.map(account => ({
    id: account.id ?? 0,
    name: account.name ?? '',
    number: account.number ?? null,
    current_balance: account.current_balance ?? 0,
    current_balance_date: account.current_balance_date ?? '',
    current_balance_in_base_currency: account.current_balance_in_base_currency ?? 0,
    safe_balance: account.safe_balance ?? null,
    safe_balance_in_base_currency: account.safe_balance_in_base_currency ?? null,
    starting_balance: account.starting_balance ?? 0,
    starting_balance_date: account.starting_balance_date ?? '',
    currency_code: account.currency_code ?? '',
    type: account.type ?? '',
    institution: account.institution ? {
      id: account.institution.id ?? 0,
      title: account.institution.title ?? '',
    } : undefined,
    created_at: account.created_at,
    updated_at: account.updated_at,
  }));

  // Calculate summary
  const totalBalance = processedAccounts.reduce((sum, account) => {
    return sum + account.current_balance_in_base_currency;
  }, 0);

  const accountsByType: Record<string, number> = {};
  processedAccounts.forEach(account => {
    accountsByType[account.type] = (accountsByType[account.type] || 0) + 1;
  });

  const response: GetTransactionAccountsResponse = {
    transactionAccounts: processedAccounts,
    summary: {
      totalAccounts: transactionAccounts.length,
      totalBalance,
      accountsByType,
    },
  };

  logger.debug("Get transaction accounts processed successfully", {
    ...context,
    accountCount: transactionAccounts.length,
    totalBalance,
  });

  return response;
}

export const registerGetTransactionAccountsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_transaction_accounts";
  const toolDescription = "Get user's transaction accounts from PocketSmith with detailed information";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterTool",
      toolName: toolName,
    });

  logger.info(`Registering tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      registerTool(server,
        toolName,
        {
          title: "Get PocketSmith Transaction Accounts",
          description: toolDescription,
          inputSchema: GetTransactionAccountsInputSchema.shape,
          outputSchema: GetTransactionAccountsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetTransactionAccountsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getTransactionAccountsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getTransactionAccountsHandler",
              context: handlerContext,
              input: params,
            }) as McpError;

            return {
              isError: true,
              content: [{ type: "text", text: `Error: ${mcpError.message}` }],
              structuredContent: {
                code: mcpError.code,
                message: mcpError.message,
                details: mcpError.details,
              },
            };
          }
        },
      );

      logger.info(
        `Tool '${toolName}' registered successfully.`,
        registrationContext,
      );
    },
    {
      operation: `RegisteringTool_${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    },
  );
};
