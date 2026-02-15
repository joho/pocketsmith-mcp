/**
 * @fileoverview Update an existing transaction in PocketSmith
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
import { NULLABLE_FIELDS, registerTool } from "./schemaHelpers.js";

export const UpdateTransactionInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  transactionId: z.coerce.number().int().describe("ID of the transaction to update"),
  payee: z.string().optional().describe("New payee name for the transaction"),
  amount: z.number().optional().describe("New transaction amount (positive for income, negative for expenses)"),
  date: z.string().optional().describe("New transaction date in YYYY-MM-DD format"),
  categoryId: NULLABLE_FIELDS.category_id.describe("New category ID to assign to this transaction"),
  note: NULLABLE_FIELDS.note.describe("New note for the transaction"),
});

export type UpdateTransactionInput = z.infer<typeof UpdateTransactionInputSchema>;

export const UpdateTransactionResponseSchema = z.object({
  transaction: z.object({
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
  }).describe("The updated transaction"),
  changes: z.array(z.string()).describe("List of fields that were changed"),
  success: z.boolean().describe("Whether the transaction was updated successfully"),
});

export type UpdateTransactionResponse = z.infer<typeof UpdateTransactionResponseSchema>;

export async function updateTransactionLogic(
  params: UpdateTransactionInput,
  context: RequestContext,
): Promise<UpdateTransactionResponse> {
  logger.debug("Processing update transaction request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get the original transaction to compare changes
  const originalTransaction = await service.getTransaction(params.transactionId, context);
  
  // Build the updates object
  const updates: Record<string, unknown> = {};
  const changes: string[] = [];
  
  if (params.payee !== undefined && params.payee !== originalTransaction.payee) {
    updates.payee = params.payee;
    changes.push(`payee: "${originalTransaction.payee}" → "${params.payee}"`);
  }
  
  if (params.amount !== undefined && params.amount !== originalTransaction.amount) {
    updates.amount = params.amount;
    changes.push(`amount: ${originalTransaction.amount} → ${params.amount}`);
  }
  
  if (params.date !== undefined && params.date !== originalTransaction.date) {
    updates.date = params.date;
    changes.push(`date: "${originalTransaction.date}" → "${params.date}"`);
  }
  
  if (params.categoryId !== undefined && params.categoryId !== originalTransaction.category?.id) {
    updates.category_id = params.categoryId ?? undefined;
    const oldCategory = originalTransaction.category?.title || "Uncategorized";
    changes.push(`category: "${oldCategory}" → category ID ${params.categoryId}`);
  }
  
  if (params.note !== undefined && params.note !== originalTransaction.note) {
    updates.note = params.note ?? undefined;
    const oldNote = originalTransaction.note || "(empty)";
    changes.push(`note: "${oldNote}" → "${params.note}"`);
  }

  // Only make the API call if there are actual changes
  if (Object.keys(updates).length === 0) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "No changes detected. Please specify at least one field to update."
    );
  }
  
  // Update the transaction
  const updatedTransaction = await service.updateTransaction(
    params.transactionId,
    updates,
    context
  );

  const response: UpdateTransactionResponse = {
    transaction: {
      id: updatedTransaction.id ?? 0,
      payee: updatedTransaction.payee ?? '',
      amount: updatedTransaction.amount ?? 0,
      date: updatedTransaction.date ?? '',
      note: updatedTransaction.note ?? null,
      category: updatedTransaction.category ? {
        id: updatedTransaction.category.id ?? 0,
        title: updatedTransaction.category.title ?? '',
      } : undefined,
      account: {
        id: updatedTransaction.transaction_account?.id ?? 0,
        name: updatedTransaction.transaction_account?.name ?? '',
      },
      currency_code: (updatedTransaction as { currency_code?: string }).currency_code ?? '',
      type: updatedTransaction.type ?? '',
    },
    changes,
    success: true,
  };

  logger.debug("Update transaction processed successfully", {
    ...context,
    transactionId: params.transactionId,
    changesCount: changes.length,
  });

  return response;
}

export const registerUpdateTransactionTool = async (server: McpServer): Promise<void> => {
  const toolName = "update_transaction";
  const toolDescription = "Update an existing transaction in PocketSmith (change payee, amount, category, etc.)";

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
          title: "Update PocketSmith Transaction",
          description: toolDescription,
          inputSchema: UpdateTransactionInputSchema.shape,
          outputSchema: UpdateTransactionResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: UpdateTransactionInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await updateTransactionLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "updateTransactionHandler",
              context: handlerContext,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
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
