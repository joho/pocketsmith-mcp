/**
 * @fileoverview Get spending categories from PocketSmith
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

export const GetCategoriesInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetCategoriesInput = z.infer<typeof GetCategoriesInputSchema>;

export const GetCategoriesResponseSchema = z.object({
  categories: z.array(z.object({
    id: z.number(),
    title: z.string(),
    colour: z.string().nullable(),
    is_bill: z.boolean(),
    is_transfer: z.boolean(),
    parent_id: z.number().nullable(),
    children: z.array(z.object({
      id: z.number(),
      title: z.string(),
      colour: z.string().nullable(),
    })).optional(),
  })).describe("List of spending categories"),
  summary: z.object({
    totalCategories: z.number(),
    billCategories: z.number(),
    transferCategories: z.number(),
    parentCategories: z.number(),
  }).describe("Summary of categories"),
});

export type GetCategoriesResponse = z.infer<typeof GetCategoriesResponseSchema>;

export async function getCategoriesLogic(
  params: GetCategoriesInput,
  context: RequestContext,
): Promise<GetCategoriesResponse> {
  logger.debug("Processing get categories request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get categories
  const categories = await service.getCategories(user.id ?? 0, context);

  // Process categories and create hierarchy
  const processedCategories = categories.map((category: any) => ({
    id: category.id ?? 0,
    title: category.title ?? '',
    colour: category.colour ?? null,
    is_bill: category.is_bill ?? false,
    is_transfer: category.is_transfer ?? false,
    parent_id: category.parent_id ?? null,
    children: category.children?.map((child: any) => ({
      id: child.id ?? 0,
      title: child.title ?? '',
      colour: child.colour ?? null,
    })),
  }));

  // Calculate summary
  const summary = {
    totalCategories: categories.length,
    billCategories: categories.filter((c: any) => c.is_bill ?? false).length,
    transferCategories: categories.filter((c: any) => c.is_transfer ?? false).length,
    parentCategories: categories.filter((c: any) => !c.parent_id).length,
  };

  const response: GetCategoriesResponse = {
    categories: processedCategories,
    summary,
  };

  logger.debug("Get categories processed successfully", {
    ...context,
    categoryCount: categories.length,
  });

  return response;
}

export const registerGetCategoresTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_categories";
  const toolDescription = "Get spending categories from PocketSmith";

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
          title: "Get PocketSmith Categories",
          description: toolDescription,
          inputSchema: GetCategoriesInputSchema.shape,
          outputSchema: GetCategoriesResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetCategoriesInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getCategoriesLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getCategoriesHandler",
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
