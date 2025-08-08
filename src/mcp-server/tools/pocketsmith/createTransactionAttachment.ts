/**
 * @fileoverview Create an attachment and assign it to a transaction in PocketSmith
 * This tool handles the two-step process: creating a user attachment then assigning it to a transaction
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

export const CreateTransactionAttachmentInputSchema = z.object({
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
    .describe("ID of the transaction to add attachment to"),
  title: z
    .string()
    .optional()
    .describe(
      "Title/name for the attachment (will be derived from filename if not provided)"
    ),
  fileName: z
    .string()
    .optional()
    .describe("Original filename of the attachment"),
  fileData: z
    .string()
    .optional()
    .describe(
      "Base64-encoded file contents (png, jpg, pdf, xls, xlsx, doc, docx)"
    ),
  userId: z
    .number()
    .int()
    .optional()
    .describe("User ID (defaults to current user if not provided)"),
});

export type CreateTransactionAttachmentInput = z.infer<
  typeof CreateTransactionAttachmentInputSchema
>;

export const CreateTransactionAttachmentResponseSchema = z.object({
  attachment: z
    .object({
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
    .describe("The created attachment"),
  transactionId: z
    .number()
    .describe("ID of the transaction the attachment was added to"),
  success: z
    .boolean()
    .describe("Whether the attachment was created successfully"),
});

export type CreateTransactionAttachmentResponse = z.infer<
  typeof CreateTransactionAttachmentResponseSchema
>;

export async function createTransactionAttachmentLogic(
  params: CreateTransactionAttachmentInput,
  context: RequestContext
): Promise<CreateTransactionAttachmentResponse> {
  logger.debug("Processing create transaction attachment request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken =
    params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);

  // Get user ID if not provided
  let userId = params.userId;
  if (!userId) {
    const currentUser = await service.getCurrentUser(context);
    userId = currentUser.id ?? 0;
  }

  // Step 1: Create the attachment for the user
  const attachment = await service.createUserAttachment(
    userId!,
    {
      title: params.title,
      file_name: params.fileName,
      file_data: params.fileData,
    },
    context
  );

  // Step 2: Assign the attachment to the transaction
  await service.assignAttachmentToTransaction(
    params.transactionId,
    attachment.id ?? 0,
    context
  );

  const response: CreateTransactionAttachmentResponse = {
    attachment: {
      id: attachment.id ?? 0,
      title: attachment.title ?? "",
      file_name: attachment.file_name,
      type: attachment.type,
      content_type: attachment.content_type,
      original_url: attachment.original_url,
      variants: attachment.variants,
      created_at: attachment.created_at,
      updated_at: attachment.updated_at,
    },
    transactionId: params.transactionId,
    success: true,
  };

  logger.debug("Create transaction attachment processed successfully", {
    ...context,
    transactionId: params.transactionId,
    attachmentId: attachment.id,
    title: params.title,
  });

  return response;
}

export const registerCreateTransactionAttachmentTool = async (
  server: McpServer
): Promise<void> => {
  const toolName = "create_transaction_attachment";
  const toolDescription =
    "Add an attachment to a specific transaction for receipt or document management";

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
          title: "Create PocketSmith Transaction Attachment",
          description: toolDescription,
          inputSchema: CreateTransactionAttachmentInputSchema.shape,
          outputSchema: CreateTransactionAttachmentResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: CreateTransactionAttachmentInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: {
                ...params,
                apiKey: "[REDACTED]",
                accessToken: "[REDACTED]",
              },
            });

          try {
            const result = await createTransactionAttachmentLogic(
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
              operation: "createTransactionAttachmentHandler",
              context: handlerContext,
              input: {
                ...params,
                apiKey: "[REDACTED]",
                accessToken: "[REDACTED]",
              },
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
