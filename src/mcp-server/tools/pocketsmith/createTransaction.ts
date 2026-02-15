/**
 * @fileoverview Create a new transaction in PocketSmith
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

export const CreateTransactionInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  accountId: z.number().int().describe("ID of the transaction account to add the transaction to"),
  payee: z.string().min(1).describe("Name of the payee for this transaction"),
  amount: z.number().describe("Transaction amount (positive for income, negative for expenses)"),
  date: z.string().describe("Transaction date in YYYY-MM-DD format"),
  categoryId: NULLABLE_FIELDS.category_id.describe("ID of the category to assign to this transaction"),
  note: NULLABLE_FIELDS.note.describe("Optional note for the transaction"),
});

export type CreateTransactionInput = z.infer<typeof CreateTransactionInputSchema>;

export const CreateTransactionResponseSchema = z.object({
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
  }).describe("The created transaction"),
  success: z.boolean().describe("Whether the transaction was created successfully"),
});

export type CreateTransactionResponse = z.infer<typeof CreateTransactionResponseSchema>;

export async function createTransactionLogic(
  params: CreateTransactionInput,
  context: RequestContext,
): Promise<CreateTransactionResponse> {
  logger.debug("Processing create transaction request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Create the transaction
  const transaction = await service.createTransaction(
    params.accountId,
    {
      payee: params.payee,
      amount: params.amount,
      date: params.date,
      category_id: params.categoryId ?? undefined,
      note: params.note ?? undefined,
    },
    context
  );

  const response: CreateTransactionResponse = {
    transaction: {
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
    },
    success: true,
  };

  logger.debug("Create transaction processed successfully", {
    ...context,
    transactionId: transaction.id,
    amount: transaction.amount,
  });

  return response;
}

export const registerCreateTransactionTool = async (server: McpServer): Promise<void> => {
  const toolName = "create_transaction";
  const toolDescription = "Create a new transaction in PocketSmith";

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
          title: "Create PocketSmith Transaction",
          description: toolDescription,
          inputSchema: CreateTransactionInputSchema.shape,
          outputSchema: CreateTransactionResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: CreateTransactionInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await createTransactionLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "createTransactionHandler",
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
