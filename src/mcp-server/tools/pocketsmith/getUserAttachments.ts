/**
 * @fileoverview Get all attachments for a user from PocketSmith
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

export const GetUserAttachmentsInputSchema = z.object({
  apiKey: z
    .string()
    .optional()
    .describe("PocketSmith API key (if not set via environment)"),
  accessToken: z
    .string()
    .optional()
    .describe("OAuth access token (if not using API key)"),
  userId: z
    .number()
    .int()
    .optional()
    .describe("User ID (defaults to current user if not provided)"),
});

export type GetUserAttachmentsInput = z.infer<
  typeof GetUserAttachmentsInputSchema
>;

export const GetUserAttachmentsResponseSchema = z.object({
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
    .describe("List of all user attachments"),
  userId: z.number().describe("ID of the user"),
  count: z.number().describe("Number of attachments found"),
});

export type GetUserAttachmentsResponse = z.infer<
  typeof GetUserAttachmentsResponseSchema
>;

export async function getUserAttachmentsLogic(
  params: GetUserAttachmentsInput,
  context: RequestContext
): Promise<GetUserAttachmentsResponse> {
  logger.debug("Processing get user attachments request", {
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

  // Get the user attachments
  const attachments = await service.getUserAttachments(userId!, context);

  const response: GetUserAttachmentsResponse = {
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
    userId: userId!,
    count: (attachments || []).length,
  };

  logger.debug("Get user attachments processed successfully", {
    ...context,
    userId: userId,
    attachmentCount: response.count,
  });

  return response;
}

export const registerGetUserAttachmentsTool = async (
  server: McpServer
): Promise<void> => {
  const toolName = "get_user_attachments";
  const toolDescription =
    "Get all attachments for a user across all transactions";

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
          title: "Get PocketSmith User Attachments",
          description: toolDescription,
          inputSchema: GetUserAttachmentsInputSchema.shape,
          outputSchema: GetUserAttachmentsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetUserAttachmentsInput) => {
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
            const result = await getUserAttachmentsLogic(
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
              operation: "getUserAttachmentsHandler",
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
