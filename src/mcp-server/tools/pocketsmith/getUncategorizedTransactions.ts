/**
 * @fileoverview Get uncategorized transactions from PocketSmith - optimized for categorization workflows
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

export const GetUncategorizedTransactionsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  startDate: z.string().optional().describe("Start date for transaction search (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("End date for transaction search (YYYY-MM-DD)"),
  page: z.number().int().min(1).optional().default(1).describe("Page number for pagination (starts at 1)"),
  limit: z.number().int().min(1).max(100).optional().default(50).describe("Number of transactions per page for preview"),
});

export type GetUncategorizedTransactionsInput = z.infer<typeof GetUncategorizedTransactionsInputSchema>;

export const GetUncategorizedTransactionsResponseSchema = z.object({
  transactions: z.array(z.object({
    id: z.number(),
    payee: z.string(),
    amount: z.number(),
    date: z.string(),
    note: z.string().nullable(),
    account: z.object({
      id: z.number(),
      name: z.string(),
    }),
    currency_code: z.string(),
    type: z.string(),
    confirmationStatus: z.enum(["uncategorized", "needs_review"]).describe("Whether this transaction needs categorization or review"),
  })).describe("List of uncategorized transactions"),
  summary: z.object({
    totalCount: z.number(),
    currentPage: z.number(),
    hasMorePages: z.boolean(),
    totalAmount: z.number(),
    uncategorizedCount: z.number(),
    needsReviewCount: z.number(),
  }).describe("Summary of uncategorized transactions"),
});

export type GetUncategorizedTransactionsResponse = z.infer<typeof GetUncategorizedTransactionsResponseSchema>;

export async function getUncategorizedTransactionsLogic(
  params: GetUncategorizedTransactionsInput,
  context: RequestContext,
): Promise<GetUncategorizedTransactionsResponse> {
  logger.debug("Processing get uncategorized transactions request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get uncategorized transactions
  const uncategorizedTransactions = await service.getTransactions(user.id ?? 0, context, {
    startDate: params.startDate,
    endDate: params.endDate,
    page: params.page,
    uncategorized: true,
  });

  // Get transactions that need review (if on first page, also check needs_review)
  let needsReviewTransactions: any[] = [];
  if (params.page === 1) {
    try {
      needsReviewTransactions = await service.getTransactions(user.id ?? 0, context, {
        startDate: params.startDate,
        endDate: params.endDate,
        page: 1,
        needsReview: true,
      });
    } catch (error) {
      logger.debug("Could not fetch needs_review transactions", { ...context, error });
    }
  }

  // Combine and process transactions
  const allTransactions = [...uncategorizedTransactions];
  
  // Add needs_review transactions that aren't already uncategorized
  const uncategorizedIds = new Set(uncategorizedTransactions.map(t => t.id));
  const uniqueNeedsReviewTransactions = needsReviewTransactions.filter(t => !uncategorizedIds.has(t.id));
  allTransactions.push(...uniqueNeedsReviewTransactions);

  // Sort by date (newest first)
  allTransactions.sort((a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime());

  // Apply limit if specified
  const limitedTransactions = params.limit ? allTransactions.slice(0, params.limit) : allTransactions;

  let totalAmount = 0;
  let uncategorizedCount = 0;
  let needsReviewCount = 0;
  
  const processedTransactions = limitedTransactions.map(transaction => {
    const amount = transaction.amount ?? 0;
    totalAmount += amount;
    
    // Determine confirmation status
    const isUncategorized = !transaction.category || !transaction.category.id;
    const confirmationStatus: "uncategorized" | "needs_review" = isUncategorized ? "uncategorized" : "needs_review";
    
    if (confirmationStatus === "uncategorized") {
      uncategorizedCount++;
    } else {
      needsReviewCount++;
    }
    
    return {
      id: transaction.id ?? 0,
      payee: transaction.payee ?? '',
      amount: amount,
      date: transaction.date ?? '',
      note: transaction.note ?? null,
      account: {
        id: transaction.transaction_account?.id ?? 0,
        name: transaction.transaction_account?.name ?? '',
      },
      currency_code: transaction.transaction_account?.currency_code ?? '',
      type: transaction.type ?? '',
      confirmationStatus,
    };
  });

  const response: GetUncategorizedTransactionsResponse = {
    transactions: processedTransactions,
    summary: {
      totalCount: allTransactions.length,
      currentPage: params.page ?? 1,
      hasMorePages: allTransactions.length >= (params.limit ?? 50),
      totalAmount,
      uncategorizedCount,
      needsReviewCount,
    },
  };

  logger.debug("Get uncategorized transactions processed successfully", {
    ...context,
    transactionCount: allTransactions.length,
    uncategorizedCount,
    needsReviewCount,
  });

  return response;
}

export const registerGetUncategorizedTransactionsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_uncategorized_transactions";
  const toolDescription = "Get uncategorized transactions from PocketSmith that need categorization or review - optimized for categorization workflows";

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
          title: "Get Uncategorized PocketSmith Transactions",
          description: toolDescription,
          inputSchema: GetUncategorizedTransactionsInputSchema.shape,
          outputSchema: GetUncategorizedTransactionsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetUncategorizedTransactionsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getUncategorizedTransactionsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getUncategorizedTransactionsHandler",
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
