/**
 * @fileoverview Get transactions for a specific account from PocketSmith
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

export const GetAccountTransactionsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  accountId: z.number().int().describe("ID of the account to get transactions for"),
  startDate: z.string().optional().describe("Start date for transaction search (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("End date for transaction search (YYYY-MM-DD)"),
  search: z.string().optional().describe("Search term to filter transactions by payee or note"),
  limit: z.number().int().min(1).max(1000).optional().default(50).describe("Maximum number of transactions to return (1-1000, default 50)"),
});

export type GetAccountTransactionsInput = z.infer<typeof GetAccountTransactionsInputSchema>;

export const GetAccountTransactionsResponseSchema = z.object({
  account: z.object({
    id: z.number(),
    name: z.string(),
    type: z.string(),
    currency_code: z.string(),
    current_balance: z.number(),
  }).describe("Account information"),
  transactions: z.array(z.object({
    id: z.number(),
    payee: z.string(),
    amount: z.number(),
    date: z.string(),
    note: z.string().nullable(),
    category: z.object({
      id: z.number(),
      title: z.string(),
    }).optional(),
    currency_code: z.string(),
    type: z.string(),
  })).describe("List of transactions for the account"),
  summary: z.object({
    totalCount: z.number(),
    totalCredit: z.number(),
    totalDebit: z.number(),
    netAmount: z.number(),
    dateRange: z.string().optional(),
  }).describe("Summary of account transactions"),
});

export type GetAccountTransactionsResponse = z.infer<typeof GetAccountTransactionsResponseSchema>;

export async function getAccountTransactionsLogic(
  params: GetAccountTransactionsInput,
  context: RequestContext,
): Promise<GetAccountTransactionsResponse> {
  logger.debug("Processing get account transactions request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first to fetch transaction accounts
  const user = await service.getCurrentUser(context);
  const transactionAccounts = await service.getTransactionAccounts(user.id!, context);
  
  // Find the requested transaction account
  const account = transactionAccounts.find((acc: any) => acc.id === params.accountId);
  if (!account) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `Transaction account with ID ${params.accountId} not found`
    );
  }
  
  // Get account transactions
  const transactions = await service.getAccountTransactions(
    params.accountId,
    context,
    {
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      limit: params.limit,
    }
  );

  // Calculate summary
  let totalCredit = 0;
  let totalDebit = 0;
  
  const processedTransactions = transactions.map((transaction: any) => {
    const amount = transaction.amount ?? 0;
    if (amount > 0) {
      totalCredit += amount;
    } else {
      totalDebit += Math.abs(amount);
    }
    
    return {
      id: transaction.id ?? 0,
      payee: transaction.payee ?? '',
      amount,
      date: transaction.date ?? '',
      note: transaction.note ?? null,
      category: transaction.category ? {
        id: transaction.category.id ?? 0,
        title: transaction.category.title ?? '',
      } : undefined,
      currency_code: (transaction as { currency_code?: string }).currency_code ?? '',
      type: transaction.type ?? '',
    };
  });

  const dateRange = params.startDate && params.endDate 
    ? `${params.startDate} to ${params.endDate}`
    : undefined;

  const response: GetAccountTransactionsResponse = {
    account: {
      id: account.id ?? 0,
      name: account.name ?? '',
      type: account.type ?? '',
      currency_code: account.currency_code ?? '',
      current_balance: account.current_balance ?? 0,
    },
    transactions: processedTransactions,
    summary: {
      totalCount: transactions.length,
      totalCredit,
      totalDebit,
      netAmount: totalCredit - totalDebit,
      dateRange,
    },
  };

  logger.debug("Get account transactions processed successfully", {
    ...context,
    accountId: params.accountId,
    transactionCount: transactions.length,
    totalCredit,
    totalDebit,
  });

  return response;
}

export const registerGetAccountTransactionsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_account_transactions";
  const toolDescription = "Get transactions for a specific account with optional filtering";

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
          title: "Get Account Transactions",
          description: toolDescription,
          inputSchema: GetAccountTransactionsInputSchema.shape,
          outputSchema: GetAccountTransactionsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetAccountTransactionsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getAccountTransactionsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getAccountTransactionsHandler",
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
