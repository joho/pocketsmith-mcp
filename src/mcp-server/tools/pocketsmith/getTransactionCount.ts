/**
 * @fileoverview Get transaction counts and previews from PocketSmith without fetching full data
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

export const GetTransactionCountInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  startDate: z.string().optional().describe("Start date for transaction search (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("End date for transaction search (YYYY-MM-DD)"),
  search: z.string().optional().describe("Search term to filter transactions by payee or note"),
  type: z.enum(["credit", "debit"]).optional().describe("Filter by transaction type"),
});

export type GetTransactionCountInput = z.infer<typeof GetTransactionCountInputSchema>;

export const GetTransactionCountResponseSchema = z.object({
  counts: z.object({
    total: z.number().describe("Total number of transactions matching filters"),
    uncategorized: z.number().describe("Number of uncategorized transactions"),
    needsReview: z.number().describe("Number of transactions needing review"),
    confirmed: z.number().describe("Number of confirmed transactions"),
  }),
  preview: z.object({
    totalAmount: z.number().describe("Total amount of all matching transactions"),
    creditAmount: z.number().describe("Total credit amount"),
    debitAmount: z.number().describe("Total debit amount"),
    dateRange: z.object({
      earliest: z.string().optional().describe("Earliest transaction date"),
      latest: z.string().optional().describe("Latest transaction date"),
    }),
  }),
  recommendations: z.object({
    suggestedBatchSize: z.number().describe("Recommended number of transactions to process at once"),
    estimatedPages: z.number().describe("Estimated number of pages with default pagination"),
    priorityOrder: z.array(z.string()).describe("Suggested order to process transactions"),
  }),
});

export type GetTransactionCountResponse = z.infer<typeof GetTransactionCountResponseSchema>;

export async function getTransactionCountLogic(
  params: GetTransactionCountInput,
  context: RequestContext,
): Promise<GetTransactionCountResponse> {
  logger.debug("Processing get transaction count request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get sample of regular transactions (first page to analyze)
  const sampleTransactions = await service.getTransactions(user.id ?? 0, context, {
    startDate: params.startDate,
    endDate: params.endDate,
    search: params.search,
    type: params.type,
    page: 1,
  });

  // Get uncategorized transactions count (first page)
  let uncategorizedSample: any[] = [];
  try {
    uncategorizedSample = await service.getTransactions(user.id ?? 0, context, {
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      type: params.type,
      page: 1,
      uncategorized: true,
    });
  } catch (error) {
    logger.debug("Could not fetch uncategorized transactions", { ...context, error });
  }

  // Get needs review transactions count (first page)
  let needsReviewSample: any[] = [];
  try {
    needsReviewSample = await service.getTransactions(user.id ?? 0, context, {
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      type: params.type,
      page: 1,
      needsReview: true,
    });
  } catch (error) {
    logger.debug("Could not fetch needs_review transactions", { ...context, error });
  }

  // Analyze the samples (this is an approximation since PocketSmith doesn't provide total counts)
  const sampleSize = sampleTransactions.length;
  
  let totalAmount = 0;
  let creditAmount = 0;
  let debitAmount = 0;
  let earliestDate: string | undefined;
  let latestDate: string | undefined;

  sampleTransactions.forEach(transaction => {
    const amount = transaction.amount ?? 0;
    totalAmount += amount;
    
    if (amount > 0) {
      creditAmount += amount;
    } else {
      debitAmount += Math.abs(amount);
    }

    const transactionDate = transaction.date;
    if (transactionDate) {
      if (!earliestDate || transactionDate < earliestDate) {
        earliestDate = transactionDate;
      }
      if (!latestDate || transactionDate > latestDate) {
        latestDate = transactionDate;
      }
    }
  });

  // Estimate counts based on whether we got a full page
  const estimatedTotal = sampleSize;
  const estimatedUncategorized = uncategorizedSample.length;
  const estimatedNeedsReview = needsReviewSample.length;
  const estimatedConfirmed = Math.max(0, estimatedTotal - estimatedUncategorized - estimatedNeedsReview);

  // Calculate recommendations
  const suggestedBatchSize = Math.min(50, Math.max(10, estimatedUncategorized + estimatedNeedsReview));
  const estimatedPages = Math.ceil(estimatedTotal / 30); // PocketSmith default page size
  
  const priorityOrder: string[] = [];
  if (estimatedUncategorized > 0) {
    priorityOrder.push("uncategorized transactions (highest priority)");
  }
  if (estimatedNeedsReview > 0) {
    priorityOrder.push("transactions needing review");
  }
  if (estimatedConfirmed > 0) {
    priorityOrder.push("confirmed transactions");
  }

  const response: GetTransactionCountResponse = {
    counts: {
      total: estimatedTotal,
      uncategorized: estimatedUncategorized,
      needsReview: estimatedNeedsReview,
      confirmed: estimatedConfirmed,
    },
    preview: {
      totalAmount,
      creditAmount,
      debitAmount,
      dateRange: {
        earliest: earliestDate,
        latest: latestDate,
      },
    },
    recommendations: {
      suggestedBatchSize,
      estimatedPages,
      priorityOrder,
    },
  };

  logger.debug("Get transaction count processed successfully", {
    ...context,
    counts: response.counts,
    estimatedPages,
  });

  return response;
}

export const registerGetTransactionCountTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_transaction_count";
  const toolDescription = "Get transaction counts and preview information without fetching full transaction data - useful for planning bulk operations";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterTool",
      toolName: toolName,
    });

  logger.info(`Registering tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.registerTool(
        toolName,
        {
          title: "Get PocketSmith Transaction Count and Preview",
          description: toolDescription,
          inputSchema: GetTransactionCountInputSchema.shape,
          outputSchema: GetTransactionCountResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetTransactionCountInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getTransactionCountLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getTransactionCountHandler",
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
