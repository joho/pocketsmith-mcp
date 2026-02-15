/**
 * @fileoverview Delete a transaction from PocketSmith
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

export const DeleteTransactionInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  transactionId: z.number().int().describe("ID of the transaction to delete"),
  confirm: z.boolean().optional().default(false).describe("Confirm deletion (required to be true)"),
});

export type DeleteTransactionInput = z.infer<typeof DeleteTransactionInputSchema>;

export const DeleteTransactionResponseSchema = z.object({
  deletedTransaction: z.object({
    id: z.number(),
    payee: z.string(),
    amount: z.number(),
    date: z.string(),
    category: z.string().optional(),
    account: z.string(),
  }).describe("Details of the deleted transaction"),
  success: z.boolean().describe("Whether the transaction was deleted successfully"),
  message: z.string().describe("Confirmation message"),
});

export type DeleteTransactionResponse = z.infer<typeof DeleteTransactionResponseSchema>;

export async function deleteTransactionLogic(
  params: DeleteTransactionInput,
  context: RequestContext,
): Promise<DeleteTransactionResponse> {
  logger.debug("Processing delete transaction request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  if (!params.confirm) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "Transaction deletion must be confirmed by setting 'confirm' to true. This action cannot be undone."
    );
  }

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get the transaction details before deleting for the response
  const transaction = await service.getTransaction(params.transactionId, context);
  
  // Delete the transaction
  await service.deleteTransaction(params.transactionId, context);

  const response: DeleteTransactionResponse = {
    deletedTransaction: {
      id: transaction.id ?? 0,
      payee: transaction.payee ?? '',
      amount: transaction.amount ?? 0,
      date: transaction.date ?? '',
      category: transaction.category?.title,
      account: transaction.transaction_account?.name ?? '',
    },
    success: true,
    message: `Transaction "${transaction.payee}" for ${transaction.amount} on ${transaction.date} has been permanently deleted.`,
  };

  logger.debug("Delete transaction processed successfully", {
    ...context,
    transactionId: params.transactionId,
    payee: transaction.payee,
  });

  return response;
}

export const registerDeleteTransactionTool = async (server: McpServer): Promise<void> => {
  const toolName = "delete_transaction";
  const toolDescription = "Delete a transaction from PocketSmith (permanent action)";

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
          title: "Delete PocketSmith Transaction",
          description: toolDescription,
          inputSchema: DeleteTransactionInputSchema.shape,
          outputSchema: DeleteTransactionResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: DeleteTransactionInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await deleteTransactionLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "deleteTransactionHandler",
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
