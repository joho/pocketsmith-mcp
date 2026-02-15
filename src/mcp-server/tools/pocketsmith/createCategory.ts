/**
 * @fileoverview Create a new spending category in PocketSmith
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

export const CreateCategoryInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  title: z.string().min(1).describe("Name of the new category"),
  colour: z.string().optional().describe("Hex color code for the category (e.g., #FF5733)"),
  parentId: z.number().int().optional().describe("ID of parent category to create this as a subcategory"),
  isBill: z.boolean().optional().default(false).describe("Whether this category represents bills/recurring expenses"),
  isTransfer: z.boolean().optional().default(false).describe("Whether this category represents transfers between accounts"),
});

export type CreateCategoryInput = z.infer<typeof CreateCategoryInputSchema>;

export const CreateCategoryResponseSchema = z.object({
  category: z.object({
    id: z.number(),
    title: z.string(),
    colour: z.string().nullable(),
    is_bill: z.boolean(),
    is_transfer: z.boolean(),
    parent_id: z.number().nullable(),
    parent_title: z.string().optional(),
    created_at: z.string().optional(),
  }).describe("The created category"),
  success: z.boolean().describe("Whether the category was created successfully"),
  message: z.string().describe("Success message"),
});

export type CreateCategoryResponse = z.infer<typeof CreateCategoryResponseSchema>;

export async function createCategoryLogic(
  params: CreateCategoryInput,
  context: RequestContext,
): Promise<CreateCategoryResponse> {
  logger.debug("Processing create category request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Validate parent category if specified
  let parentTitle: string | undefined;
  if (params.parentId) {
    try {
      const categories = await service.getCategories(user.id!, context);
      const parentCategory = categories.find((cat: any) => cat.id === params.parentId);
      if (!parentCategory) {
        throw new McpError(
          BaseErrorCode.NOT_FOUND,
          `Parent category with ID ${params.parentId} not found`
        );
      }
      parentTitle = parentCategory.title;
    } catch (error) {
      if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
        throw error;
      }
      // If we can't fetch categories, proceed anyway - the API will validate
    }
  }
  
  // Create the category
  const category = await service.createCategory(
    user.id!,
    {
      title: params.title,
      colour: params.colour,
      parent_id: params.parentId,
      is_bill: params.isBill,
      is_transfer: params.isTransfer,
    },
    context
  );

  const categoryType = params.isBill ? 'bill' : params.isTransfer ? 'transfer' : 'expense';
  const parentInfo = parentTitle ? ` under "${parentTitle}"` : '';
  
  const response: CreateCategoryResponse = {
    category: {
      id: category.id ?? 0,
      title: category.title ?? '',
      colour: category.colour ?? null,
      is_bill: category.is_bill ?? false,
      is_transfer: category.is_transfer ?? false,
      parent_id: category.parent_id ?? null,
      parent_title: parentTitle,
      created_at: category.created_at,
    },
    success: true,
    message: `Successfully created ${categoryType} category "${params.title}"${parentInfo}`,
  };

  logger.debug("Create category processed successfully", {
    ...context,
    categoryId: category.id,
    title: params.title,
  });

  return response;
}

export const registerCreateCategoryTool = async (server: McpServer): Promise<void> => {
  const toolName = "create_category";
  const toolDescription = "Create a new spending category in PocketSmith";

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
          title: "Create PocketSmith Category",
          description: toolDescription,
          inputSchema: CreateCategoryInputSchema.shape,
          outputSchema: CreateCategoryResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: CreateCategoryInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await createCategoryLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "createCategoryHandler",
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
