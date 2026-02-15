/**
 * @fileoverview Get attachments for a specific transaction from PocketSmith
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

export const GetTransactionAttachmentsInputSchema = z.object({
  apiKey: z
    .string()
    .optional()
    .describe("PocketSmith API key (if not set via environment)"),
  accessToken: z
    .string()
    .optional()
    .describe("OAuth access token (if not using API key)"),
  transactionId: z
    .number()
    .int()
    .describe("ID of the transaction to get attachments for"),
});

export type GetTransactionAttachmentsInput = z.infer<
  typeof GetTransactionAttachmentsInputSchema
>;

export const GetTransactionAttachmentsResponseSchema = z.object({
  attachments: z
    .array(
      z.object({
        id: z.number(),
        title: z.string(),
        file_name: z.string().optional(),
        type: z.string().optional(),
        content_type: z.string().optional(),
        original_url: z.string().optional(),
        variants: z
          .object({
            large_url: z.string().optional(),
            thumb_url: z.string().optional(),
          })
          .optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      })
    )
    .describe("List of attachments for the transaction"),
  transactionId: z.number().describe("ID of the transaction"),
  count: z.number().describe("Number of attachments found"),
});

export type GetTransactionAttachmentsResponse = z.infer<
  typeof GetTransactionAttachmentsResponseSchema
>;

export async function getTransactionAttachmentsLogic(
  params: GetTransactionAttachmentsInput,
  context: RequestContext
): Promise<GetTransactionAttachmentsResponse> {
  logger.debug("Processing get transaction attachments request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken =
    params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);

  // Get the transaction attachments
  const attachments = await service.getTransactionAttachments(
    params.transactionId,
    context
  );

  const response: GetTransactionAttachmentsResponse = {
    attachments: (attachments || []).map((attachment) => ({
      id: attachment.id ?? 0,
      title: attachment.title ?? "",
      file_name: attachment.file_name,
      type: attachment.type,
      content_type: attachment.content_type,
      original_url: attachment.original_url,
      variants: attachment.variants,
      created_at: attachment.created_at,
      updated_at: attachment.updated_at,
    })),
    transactionId: params.transactionId,
    count: (attachments || []).length,
  };

  logger.debug("Get transaction attachments processed successfully", {
    ...context,
    transactionId: params.transactionId,
    attachmentCount: response.count,
  });

  return response;
}

export const registerGetTransactionAttachmentsTool = async (
  server: McpServer
): Promise<void> => {
  const toolName = "get_transaction_attachments";
  const toolDescription = "Get all attachments for a specific transaction";

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
          title: "Get PocketSmith Transaction Attachments",
          description: toolDescription,
          inputSchema: GetTransactionAttachmentsInputSchema.shape,
          outputSchema: GetTransactionAttachmentsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetTransactionAttachmentsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getTransactionAttachmentsLogic(
              params,
              handlerContext
            );
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getTransactionAttachmentsHandler",
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
        }
      );

      logger.info(
        `Tool '${toolName}' registered successfully.`,
        registrationContext
      );
    },
    {
      operation: `RegisteringTool_${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    }
  );
};
