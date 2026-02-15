/**
 * @fileoverview Get user accounts from PocketSmith
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

export const GetAccountsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetAccountsInput = z.infer<typeof GetAccountsInputSchema>;

export const GetAccountsResponseSchema = z.object({
  user: z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
  }).describe("Current user information"),
  accounts: z.array(z.object({
    id: z.number(),
    name: z.string(),
    type: z.string(),
    currency_code: z.string(),
    current_balance: z.number(),
    current_balance_date: z.string(),
    current_balance_exchange_rate: z.number().nullable(),
    current_balance_in_base_currency: z.number(),
    safe_balance: z.number().nullable(),
    safe_balance_in_base_currency: z.number().nullable(),
  })).describe("List of user accounts with balances"),
  totalBalance: z.number().describe("Total balance across all accounts in base currency"),
});

export type GetAccountsResponse = z.infer<typeof GetAccountsResponseSchema>;

export async function getAccountsLogic(
  params: GetAccountsInput,
  context: RequestContext,
): Promise<GetAccountsResponse> {
  logger.debug("Processing get accounts request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get user's accounts
  const accounts = await service.getAccounts(user.id ?? 0, context);
  
  // Calculate total balance
  const totalBalance = accounts.reduce((sum: number, account: any) => {
    return sum + (account.current_balance_in_base_currency || 0);
  }, 0);

  const response: GetAccountsResponse = {
    user: {
      id: user.id ?? 0,
      name: user.name ?? '',
      email: user.email ?? '',
    },
    accounts: accounts.map((account: any) => ({
      id: account.id ?? 0,
      name: account.title ?? '',
      type: account.type ?? '',
      currency_code: account.currency_code ?? '',
      current_balance: account.current_balance ?? 0,
      current_balance_date: account.current_balance_date ?? '',
      current_balance_exchange_rate: account.current_balance_exchange_rate ?? null,
      current_balance_in_base_currency: account.current_balance_in_base_currency ?? 0,
      safe_balance: account.safe_balance ?? null,
      safe_balance_in_base_currency: account.safe_balance_in_base_currency ?? null,
    })),
    totalBalance,
  };

  logger.debug("Get accounts processed successfully", {
    ...context,
    accountCount: accounts.length,
    totalBalance,
  });

  return response;
}

export const registerGetAccountsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_accounts";
  const toolDescription = "Get user's PocketSmith accounts with current balances";

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
          title: "Get PocketSmith Accounts",
          description: toolDescription,
          inputSchema: GetAccountsInputSchema.shape,
          outputSchema: GetAccountsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetAccountsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getAccountsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getAccountsHandler",
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
