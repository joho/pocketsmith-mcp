/**
 * @fileoverview Get a specific transaction by ID from PocketSmith
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

export const GetTransactionInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  transactionId: z.number().int().describe("ID of the transaction to retrieve"),
});

export type GetTransactionInput = z.infer<typeof GetTransactionInputSchema>;

export const GetTransactionResponseSchema = z.object({
  transaction: z.object({
    id: z.number(),
    payee: z.string(),
    amount: z.number(),
    date: z.string(),
    note: z.string().nullable(),
    category: z.object({
      id: z.number(),
      title: z.string(),
      colour: z.string().nullable(),
    }).optional(),
    account: z.object({
      id: z.number(),
      name: z.string(),
      type: z.string(),
    }),
    currency_code: z.string(),
    type: z.string(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  }).describe("The requested transaction details"),
});

export type GetTransactionResponse = z.infer<typeof GetTransactionResponseSchema>;

export async function getTransactionLogic(
  params: GetTransactionInput,
  context: RequestContext,
): Promise<GetTransactionResponse> {
  logger.debug("Processing get transaction request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get the transaction
  const transaction = await service.getTransaction(params.transactionId, context);

  const response: GetTransactionResponse = {
    transaction: {
      id: transaction.id ?? 0,
      payee: transaction.payee ?? '',
      amount: transaction.amount ?? 0,
      date: transaction.date ?? '',
      note: transaction.note ?? null,
      category: transaction.category ? {
        id: transaction.category.id ?? 0,
        title: transaction.category.title ?? '',
        colour: transaction.category.colour ?? null,
      } : undefined,
      account: {
        id: transaction.transaction_account?.id ?? 0,
        name: transaction.transaction_account?.name ?? '',
        type: transaction.transaction_account?.type ?? '',
      },
      currency_code: (transaction as { currency_code?: string }).currency_code ?? '',
      type: transaction.type ?? '',
      created_at: transaction.created_at,
      updated_at: transaction.updated_at,
    },
  };

  logger.debug("Get transaction processed successfully", {
    ...context,
    transactionId: params.transactionId,
    payee: transaction.payee,
  });

  return response;
}

export const registerGetTransactionTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_transaction";
  const toolDescription = "Get detailed information about a specific transaction by ID";

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
          title: "Get PocketSmith Transaction",
          description: toolDescription,
          inputSchema: GetTransactionInputSchema.shape,
          outputSchema: GetTransactionResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetTransactionInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getTransactionLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getTransactionHandler",
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
