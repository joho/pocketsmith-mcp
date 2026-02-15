/**
 * @fileoverview Update an existing category in PocketSmith
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
import { NULLABLE_FIELDS, REQUIRED_NULLABLE_FIELDS, registerTool } from "./schemaHelpers.js";

export const UpdateCategoryInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  categoryId: z.coerce.number().int().describe("ID of the category to update"),
  title: z.string().optional().describe("New name for the category"),
  colour: NULLABLE_FIELDS.colour.describe("New hex color code for the category (e.g., #FF5733)"),
  parentId: NULLABLE_FIELDS.parent_id.describe("New parent category ID (use null to remove parent)"),
  isBill: z.boolean().optional().describe("Whether this category represents bills/recurring expenses"),
  isTransfer: z.boolean().optional().describe("Whether this category represents transfers between accounts"),
});

export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;

export const UpdateCategoryResponseSchema = z.object({
  category: z.object({
    id: z.number(),
    title: z.string(),
    colour: REQUIRED_NULLABLE_FIELDS.colour,
    is_bill: z.boolean(),
    is_transfer: z.boolean(),
    parent_id: REQUIRED_NULLABLE_FIELDS.parent_id,
    updated_at: NULLABLE_FIELDS.updated_at,
  }).describe("The updated category"),
  changes: z.array(z.string()).describe("List of fields that were changed"),
  success: z.boolean().describe("Whether the category was updated successfully"),
});

export type UpdateCategoryResponse = z.infer<typeof UpdateCategoryResponseSchema>;

export async function updateCategoryLogic(
  params: UpdateCategoryInput,
  context: RequestContext,
): Promise<UpdateCategoryResponse> {
  logger.debug("Processing update category request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user to fetch existing categories for comparison
  const user = await service.getCurrentUser(context);
  const categories = await service.getCategories(user.id!, context);
  
  // Find the original category
  const originalCategory = categories.find(cat => cat.id === params.categoryId);
  if (!originalCategory) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `Category with ID ${params.categoryId} not found`
    );
  }
  
  // Build the updates object and track changes
  const updates: Record<string, unknown> = {};
  const changes: string[] = [];
  
  if (params.title !== undefined && params.title !== originalCategory.title) {
    updates.title = params.title;
    changes.push(`title: "${originalCategory.title}" → "${params.title}"`);
  }
  
  if (params.colour !== undefined && params.colour !== originalCategory.colour) {
    updates.colour = params.colour;
    const oldColour = originalCategory.colour || "(none)";
    changes.push(`colour: "${oldColour}" → "${params.colour}"`);
  }
  
  if (params.parentId !== undefined && params.parentId !== originalCategory.parent_id) {
    updates.parent_id = params.parentId;
    const oldParent = originalCategory.parent_id || "(none)";
    changes.push(`parent: "${oldParent}" → "${params.parentId}"`);
  }
  
  if (params.isBill !== undefined && params.isBill !== originalCategory.is_bill) {
    updates.is_bill = params.isBill;
    changes.push(`is_bill: ${originalCategory.is_bill} → ${params.isBill}`);
  }
  
  if (params.isTransfer !== undefined && params.isTransfer !== originalCategory.is_transfer) {
    updates.is_transfer = params.isTransfer;
    changes.push(`is_transfer: ${originalCategory.is_transfer} → ${params.isTransfer}`);
  }

  // Only make the API call if there are actual changes
  if (Object.keys(updates).length === 0) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "No changes detected. Please specify at least one field to update."
    );
  }
  
  // Update the category
  const updatedCategory = await service.updateCategory(
    params.categoryId,
    updates,
    context
  );

  const response: UpdateCategoryResponse = {
    category: {
      id: updatedCategory.id ?? 0,
      title: updatedCategory.title ?? '',
      colour: updatedCategory.colour ?? null,
      is_bill: updatedCategory.is_bill ?? false,
      is_transfer: updatedCategory.is_transfer ?? false,
      parent_id: updatedCategory.parent_id ?? null,
      updated_at: updatedCategory.updated_at ?? null,
    },
    changes,
    success: true,
  };

  logger.debug("Update category processed successfully", {
    ...context,
    categoryId: params.categoryId,
    changesCount: changes.length,
  });

  return response;
}

export const registerUpdateCategoryTool = async (server: McpServer): Promise<void> => {
  const toolName = "update_category";
  const toolDescription = "Update an existing category in PocketSmith (change name, color, parent, etc.)";

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
          title: "Update PocketSmith Category",
          description: toolDescription,
          inputSchema: UpdateCategoryInputSchema.shape,
          outputSchema: UpdateCategoryResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: UpdateCategoryInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await updateCategoryLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "updateCategoryHandler",
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
