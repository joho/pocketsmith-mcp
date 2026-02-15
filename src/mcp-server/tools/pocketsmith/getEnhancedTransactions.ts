/**
 * @fileoverview Enhanced transaction search with multiple payees, amount ranges, and smart filtering
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

export const GetEnhancedTransactionsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  startDate: z.string().optional().describe("Start date for transaction search (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("End date for transaction search (YYYY-MM-DD)"),
  payees: z.array(z.string()).optional().describe("Array of payee names to search for (OR logic)"),
  search: z.string().optional().describe("General search term for payee or note"),
  type: z.enum(["credit", "debit"]).optional().describe("Filter by transaction type"),
  minAmount: z.number().optional().describe("Minimum amount filter (positive for credits, negative for debits)"),
  maxAmount: z.number().optional().describe("Maximum amount filter (positive for credits, negative for debits)"),
  categoryIds: z.array(z.number()).optional().describe("Filter by specific category IDs"),
  excludeCategoryIds: z.array(z.number()).optional().describe("Exclude specific category IDs"),
  accountIds: z.array(z.number()).optional().describe("Filter by specific account IDs"),
  confirmationStatus: z.array(z.enum(["confirmed", "uncategorized", "needs_review"])).optional().describe("Filter by confirmation status"),
  page: z.number().int().min(1).optional().default(1).describe("Page number for pagination"),
  limit: z.number().int().min(1).max(200).optional().default(50).describe("Number of transactions to return per page"),
});

export type GetEnhancedTransactionsInput = z.infer<typeof GetEnhancedTransactionsInputSchema>;

export const GetEnhancedTransactionsResponseSchema = z.object({
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
    account: z.object({
      id: z.number(),
      name: z.string(),
    }),
    currency_code: z.string(),
    type: z.string(),
    confirmationStatus: z.enum(["confirmed", "uncategorized", "needs_review"]),
    matchedCriteria: z.array(z.string()).describe("Which search criteria this transaction matched"),
  })).describe("List of enhanced filtered transactions"),
  summary: z.object({
    totalMatched: z.number(),
    currentPage: z.number(),
    hasMorePages: z.boolean(),
    appliedFilters: z.array(z.string()),
    matchBreakdown: z.object({
      byPayee: z.number(),
      byAmount: z.number(),
      byCategory: z.number(),
      byAccount: z.number(),
      byStatus: z.number(),
    }),
  }),
});

export type GetEnhancedTransactionsResponse = z.infer<typeof GetEnhancedTransactionsResponseSchema>;

function matchesPayeeFilter(transaction: any, payees: string[]): boolean {
  if (!payees || payees.length === 0) return true;
  const payee = (transaction.payee ?? '').toLowerCase();
  return payees.some(p => payee.includes(p.toLowerCase()));
}

function matchesAmountFilter(transaction: any, minAmount?: number, maxAmount?: number): boolean {
  const amount = transaction.amount ?? 0;
  if (minAmount !== undefined && amount < minAmount) return false;
  if (maxAmount !== undefined && amount > maxAmount) return false;
  return true;
}

function matchesCategoryFilter(transaction: any, categoryIds?: number[], excludeCategoryIds?: number[]): boolean {
  const categoryId = transaction.category?.id;
  
  if (categoryIds && categoryIds.length > 0) {
    if (!categoryId || !categoryIds.includes(categoryId)) return false;
  }
  
  if (excludeCategoryIds && excludeCategoryIds.length > 0) {
    if (categoryId && excludeCategoryIds.includes(categoryId)) return false;
  }
  
  return true;
}

function matchesAccountFilter(transaction: any, accountIds?: number[]): boolean {
  if (!accountIds || accountIds.length === 0) return true;
  const accountId = transaction.transaction_account?.id;
  return accountId && accountIds.includes(accountId);
}

function getConfirmationStatus(transaction: any): "confirmed" | "uncategorized" | "needs_review" {
  const hasCategory = transaction.category && transaction.category.id;
  if (!hasCategory) return "uncategorized";
  // For now, we'll assume categorized transactions are confirmed
  // In a real implementation, this would check if the transaction needs review
  return "confirmed";
}

function matchesConfirmationStatusFilter(transaction: any, statusFilter?: string[]): boolean {
  if (!statusFilter || statusFilter.length === 0) return true;
  const status = getConfirmationStatus(transaction);
  return statusFilter.includes(status);
}

export async function getEnhancedTransactionsLogic(
  params: GetEnhancedTransactionsInput,
  context: RequestContext,
): Promise<GetEnhancedTransactionsResponse> {
  logger.debug("Processing enhanced transaction search request", {
    ...context,
    toolInput: { ...params, payees: params.payees?.length ? `${params.payees.length} payees` : undefined },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Build applied filters list for response
  const appliedFilters: string[] = [];
  if (params.startDate || params.endDate) appliedFilters.push("date range");
  if (params.payees && params.payees.length > 0) appliedFilters.push(`payees: ${params.payees.join(', ')}`);
  if (params.search) appliedFilters.push(`search: ${params.search}`);
  if (params.type) appliedFilters.push(`type: ${params.type}`);
  if (params.minAmount !== undefined || params.maxAmount !== undefined) {
    const range = `${params.minAmount ?? '-∞'} to ${params.maxAmount ?? '+∞'}`;
    appliedFilters.push(`amount range: ${range}`);
  }
  if (params.categoryIds && params.categoryIds.length > 0) appliedFilters.push(`categories: ${params.categoryIds.join(', ')}`);
  if (params.excludeCategoryIds && params.excludeCategoryIds.length > 0) appliedFilters.push(`exclude categories: ${params.excludeCategoryIds.join(', ')}`);
  if (params.accountIds && params.accountIds.length > 0) appliedFilters.push(`accounts: ${params.accountIds.join(', ')}`);
  if (params.confirmationStatus && params.confirmationStatus.length > 0) appliedFilters.push(`status: ${params.confirmationStatus.join(', ')}`);

  // Fetch multiple pages of transactions to apply client-side filtering
  const allTransactions: any[] = [];
  let currentPage = 1;
  const maxPages = 10; // Prevent infinite loops
  
  while (currentPage <= maxPages) {
    const pageTransactions = await service.getTransactions(user.id ?? 0, context, {
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      type: params.type,
      page: currentPage,
    });
    
    if (pageTransactions.length === 0) break;
    allTransactions.push(...pageTransactions);
    
    // Stop if we got less than a full page (indicating we're at the end)
    if (pageTransactions.length < 30) break; // PocketSmith default page size
    currentPage++;
  }

  // Apply client-side filters
  const matchBreakdown = { byPayee: 0, byAmount: 0, byCategory: 0, byAccount: 0, byStatus: 0 };
  
  const filteredTransactions = allTransactions.filter(transaction => {
    const matchedCriteria: string[] = [];
    
    // Check payee filter
    if (params.payees && params.payees.length > 0) {
      if (matchesPayeeFilter(transaction, params.payees)) {
        matchedCriteria.push("payee");
        matchBreakdown.byPayee++;
      } else {
        return false;
      }
    }
    
    // Check amount filter
    if (params.minAmount !== undefined || params.maxAmount !== undefined) {
      if (matchesAmountFilter(transaction, params.minAmount, params.maxAmount)) {
        matchedCriteria.push("amount");
        matchBreakdown.byAmount++;
      } else {
        return false;
      }
    }
    
    // Check category filter
    if (params.categoryIds?.length || params.excludeCategoryIds?.length) {
      if (matchesCategoryFilter(transaction, params.categoryIds, params.excludeCategoryIds)) {
        matchedCriteria.push("category");
        matchBreakdown.byCategory++;
      } else {
        return false;
      }
    }
    
    // Check account filter
    if (params.accountIds && params.accountIds.length > 0) {
      if (matchesAccountFilter(transaction, params.accountIds)) {
        matchedCriteria.push("account");
        matchBreakdown.byAccount++;
      } else {
        return false;
      }
    }
    
    // Check confirmation status filter
    if (params.confirmationStatus && params.confirmationStatus.length > 0) {
      if (matchesConfirmationStatusFilter(transaction, params.confirmationStatus)) {
        matchedCriteria.push("status");
        matchBreakdown.byStatus++;
      } else {
        return false;
      }
    }
    
    // Store matched criteria on the transaction for response
    (transaction as any)._matchedCriteria = matchedCriteria;
    return true;
  });

  // Apply pagination to filtered results
  const startIndex = (params.page - 1) * params.limit;
  const endIndex = startIndex + params.limit;
  const paginatedTransactions = filteredTransactions.slice(startIndex, endIndex);

  // Process transactions for response
  const processedTransactions = paginatedTransactions.map(transaction => {
    const confirmationStatus = getConfirmationStatus(transaction);
    
    return {
      id: transaction.id ?? 0,
      payee: transaction.payee ?? '',
      amount: transaction.amount ?? 0,
      date: transaction.date ?? '',
      note: transaction.note ?? null,
      category: transaction.category && transaction.category.id && transaction.category.title ? {
        id: transaction.category.id,
        title: transaction.category.title,
      } : undefined,
      account: {
        id: transaction.transaction_account?.id ?? 0,
        name: transaction.transaction_account?.name ?? '',
      },
      currency_code: transaction.transaction_account?.currency_code ?? '',
      type: transaction.type ?? '',
      confirmationStatus,
      matchedCriteria: (transaction as any)._matchedCriteria || [],
    };
  });

  const response: GetEnhancedTransactionsResponse = {
    transactions: processedTransactions,
    summary: {
      totalMatched: filteredTransactions.length,
      currentPage: params.page,
      hasMorePages: endIndex < filteredTransactions.length,
      appliedFilters,
      matchBreakdown,
    },
  };

  logger.debug("Enhanced transaction search processed successfully", {
    ...context,
    totalMatched: filteredTransactions.length,
    returned: processedTransactions.length,
    appliedFilters: appliedFilters.length,
  });

  return response;
}

export const registerGetEnhancedTransactionsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_enhanced_transactions";
  const toolDescription = "Enhanced transaction search with multiple payees, amount ranges, category filtering, and smart matching";

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
          title: "Get Enhanced PocketSmith Transactions",
          description: toolDescription,
          inputSchema: GetEnhancedTransactionsInputSchema.shape,
          outputSchema: GetEnhancedTransactionsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetEnhancedTransactionsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getEnhancedTransactionsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getEnhancedTransactionsHandler",
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
