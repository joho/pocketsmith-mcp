/**
 * @fileoverview Get comprehensive user financial summary from PocketSmith
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

export const GetUserSummaryInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  includeRecentTransactions: z.boolean().optional().default(true).describe("Include recent transactions in the summary"),
  transactionLimit: z.number().int().min(1).max(50).optional().default(10).describe("Number of recent transactions to include (1-50)"),
});

export type GetUserSummaryInput = z.infer<typeof GetUserSummaryInputSchema>;

export const GetUserSummaryResponseSchema = z.object({
  user: z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    base_currency_code: z.string().optional(),
  }).describe("User information"),
  financialSummary: z.object({
    totalBalance: z.number(),
    totalAccounts: z.number(),
    accountsByType: z.record(z.string(), z.number()),
    netWorth: z.number(),
  }).describe("Overall financial position"),
  recentTransactions: z.array(z.object({
    id: z.number(),
    payee: z.string(),
    amount: z.number(),
    date: z.string(),
    account: z.string(),
    category: z.string().optional(),
  })).optional().describe("Recent transactions"),
  budgetHighlights: z.object({
    categoriesTracked: z.number(),
    overBudgetCategories: z.number(),
    totalBudgetVariance: z.number(),
  }).optional().describe("Budget performance highlights"),
  categoryBreakdown: z.array(z.object({
    category: z.string(),
    count: z.number(),
    isTransfer: z.boolean(),
    isBill: z.boolean(),
  })).describe("Category breakdown"),
});

export type GetUserSummaryResponse = z.infer<typeof GetUserSummaryResponseSchema>;

export async function getUserSummaryLogic(
  params: GetUserSummaryInput,
  context: RequestContext,
): Promise<GetUserSummaryResponse> {
  logger.debug("Processing get user summary request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user
  const user = await service.getCurrentUser(context);
  
  // Get accounts
  const accounts = await service.getAccounts(user.id ?? 0, context);
  
  // Calculate financial summary
  const totalBalance = accounts.reduce((sum, account) => {
    return sum + (account.current_balance_in_base_currency || 0);
  }, 0);

  const accountsByType: Record<string, number> = {};
  accounts.forEach(account => {
    const accountType = account.type ?? 'unknown';
    accountsByType[accountType] = (accountsByType[accountType] || 0) + 1;
  });

  // Get categories
  const categories = await service.getCategories(user.id ?? 0, context);
  
  const categoryBreakdown = categories.map(category => ({
    category: category.title ?? '',
    count: category.children?.length || 0,
    isTransfer: category.is_transfer ?? false,
    isBill: category.is_bill ?? false,
  }));

  let recentTransactions;
  if (params.includeRecentTransactions) {
    const transactions = await service.getTransactions(user.id ?? 0, context, {
      page: 1,
    });
    
    recentTransactions = transactions.map(transaction => ({
      id: transaction.id ?? 0,
      payee: transaction.payee ?? '',
      amount: transaction.amount ?? 0,
      date: transaction.date ?? '',
      account: transaction.transaction_account?.name ?? '',
      category: transaction.category?.title,
    }));
  }

  let budgetHighlights;
  try {
    const budgets = await service.getBudgets(user.id ?? 0, context);
    const categoriesWithBudgets = budgets.filter((item) => {
      const latestPeriod = item.expense?.periods?.[0];
      const budgetAmount = latestPeriod?.forecast_amount ?? 0;
      return budgetAmount > 0;
    });
    const overBudgetCategories = categoriesWithBudgets.filter((item) => {
      const actualAmount = item.expense?.total_actual_amount ?? 0;
      const latestPeriod = item.expense?.periods?.[0];
      const budgetAmount = latestPeriod?.forecast_amount ?? 0;
      return actualAmount > budgetAmount;
    });
    const totalVariance = categoriesWithBudgets.reduce((sum: number, item) => {
      const actualAmount = item.expense?.total_actual_amount ?? 0;
      const latestPeriod = item.expense?.periods?.[0];
      const budgetAmount = latestPeriod?.forecast_amount ?? 0;
      return sum + (budgetAmount - actualAmount);
    }, 0);

    budgetHighlights = {
      categoriesTracked: categoriesWithBudgets.length,
      overBudgetCategories: overBudgetCategories.length,
      totalBudgetVariance: totalVariance,
    };
  } catch (error) {
    // Budget analysis might not be available for all users
    logger.debug("Budget analysis not available", { ...context, error });
  }

  const response: GetUserSummaryResponse = {
    user: {
      id: user.id ?? 0,
      name: user.name ?? '',
      email: user.email ?? '',
      base_currency_code: user.base_currency_code,
    },
    financialSummary: {
      totalBalance,
      totalAccounts: accounts.length,
      accountsByType,
      netWorth: totalBalance, // Simplified - could be more complex with assets/liabilities
    },
    recentTransactions,
    budgetHighlights,
    categoryBreakdown,
  };

  logger.debug("Get user summary processed successfully", {
    ...context,
    accountCount: accounts.length,
    categoryCount: categories.length,
    totalBalance,
  });

  return response;
}

export const registerGetUserSummaryTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_user_summary";
  const toolDescription = "Get a comprehensive financial summary including accounts, recent transactions, budget highlights, and category breakdown";

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
          title: "Get PocketSmith User Summary",
          description: toolDescription,
          inputSchema: GetUserSummaryInputSchema.shape,
          outputSchema: GetUserSummaryResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetUserSummaryInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getUserSummaryLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getUserSummaryHandler",
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
