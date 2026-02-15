/**
 * @fileoverview Bulk update transaction categories in PocketSmith
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

export const BulkUpdateCategoriesInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  updates: z.array(z.object({
    transactionId: z.number().describe("Transaction ID to update"),
    categoryId: z.number().optional().describe("New category ID (null to uncategorize)"),
    note: z.string().optional().describe("Optional note to add or update"),
  })).min(1).max(50).describe("List of transaction updates (max 50 at once)"),
  dryRun: z.boolean().optional().default(false).describe("If true, validate updates without applying them"),
});

export type BulkUpdateCategoriesInput = z.infer<typeof BulkUpdateCategoriesInputSchema>;

export const BulkUpdateCategoriesResponseSchema = z.object({
  results: z.array(z.object({
    transactionId: z.number(),
    status: z.enum(["success", "error", "skipped"]),
    message: z.string().optional(),
    updatedTransaction: z.object({
      id: z.number(),
      payee: z.string(),
      amount: z.number(),
      date: z.string(),
      category: z.object({
        id: z.number(),
        title: z.string(),
      }).optional(),
      note: z.string().nullable(),
    }).optional(),
  })),
  summary: z.object({
    totalUpdates: z.number(),
    successful: z.number(),
    failed: z.number(),
    skipped: z.number(),
    errors: z.array(z.string()),
  }),
  dryRun: z.boolean(),
});

export type BulkUpdateCategoriesResponse = z.infer<typeof BulkUpdateCategoriesResponseSchema>;

export async function bulkUpdateCategoriesLogic(
  params: BulkUpdateCategoriesInput,
  context: RequestContext,
): Promise<BulkUpdateCategoriesResponse> {
  logger.debug("Processing bulk update categories request", {
    ...context,
    toolInput: { ...params, updates: `${params.updates.length} updates` },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  const results: BulkUpdateCategoriesResponse['results'] = [];
  const errors: string[] = [];
  let successful = 0;
  let failed = 0;
  let skipped = 0;

  for (const update of params.updates) {
    try {
      logger.debug("Processing update", { ...context, transactionId: update.transactionId });

      if (params.dryRun) {
        // For dry run, just validate the transaction exists
        try {
          const transaction = await service.getTransaction(update.transactionId, context);
          results.push({
            transactionId: update.transactionId,
            status: "success",
            message: "Dry run: Update would be applied",
            updatedTransaction: {
              id: transaction.id ?? 0,
              payee: transaction.payee ?? '',
              amount: transaction.amount ?? 0,
              date: transaction.date ?? '',
              category: update.categoryId ? {
                id: update.categoryId,
                title: `Category ${update.categoryId}`, // We'd need to fetch this in a real implementation
              } : undefined,
              note: update.note ?? transaction.note ?? null,
            },
          });
          successful++;
        } catch (error) {
          results.push({
            transactionId: update.transactionId,
            status: "error",
            message: `Dry run: Transaction not found or inaccessible`,
          });
          failed++;
          errors.push(`Transaction ${update.transactionId}: Not found or inaccessible`);
        }
      } else {
        // Actual update
        const updateData: any = {};
        
        if (update.categoryId !== undefined) {
          updateData.category_id = update.categoryId;
        }
        
        if (update.note !== undefined) {
          updateData.note = update.note;
        }

        if (Object.keys(updateData).length === 0) {
          results.push({
            transactionId: update.transactionId,
            status: "skipped",
            message: "No updates to apply",
          });
          skipped++;
          continue;
        }

        const updatedTransaction = await service.updateTransaction(
          update.transactionId,
          updateData,
          context
        );

        results.push({
          transactionId: update.transactionId,
          status: "success",
          message: "Transaction updated successfully",
          updatedTransaction: {
            id: updatedTransaction.id ?? 0,
            payee: updatedTransaction.payee ?? '',
            amount: updatedTransaction.amount ?? 0,
            date: updatedTransaction.date ?? '',
            category: updatedTransaction.category && updatedTransaction.category.id ? {
              id: updatedTransaction.category.id,
              title: updatedTransaction.category.title ?? '',
            } : undefined,
            note: updatedTransaction.note ?? null,
          },
        });
        successful++;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.push({
        transactionId: update.transactionId,
        status: "error",
        message: `Failed to update: ${errorMessage}`,
      });
      failed++;
      errors.push(`Transaction ${update.transactionId}: ${errorMessage}`);
      
      logger.debug("Failed to update transaction", {
        ...context,
        transactionId: update.transactionId,
        error: errorMessage,
      });
    }
  }

  const response: BulkUpdateCategoriesResponse = {
    results,
    summary: {
      totalUpdates: params.updates.length,
      successful,
      failed,
      skipped,
      errors,
    },
    dryRun: params.dryRun ?? false,
  };

  logger.debug("Bulk update categories processed", {
    ...context,
    summary: response.summary,
  });

  return response;
}

export const registerBulkUpdateCategoriesTool = async (server: McpServer): Promise<void> => {
  const toolName = "bulk_update_categories";
  const toolDescription = "Bulk update transaction categories in PocketSmith with optional dry-run validation";

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
          title: "Bulk Update PocketSmith Transaction Categories",
          description: toolDescription,
          inputSchema: BulkUpdateCategoriesInputSchema.shape,
          outputSchema: BulkUpdateCategoriesResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: BulkUpdateCategoriesInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await bulkUpdateCategoriesLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "bulkUpdateCategoriesHandler",
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
