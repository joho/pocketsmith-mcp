/**
 * @fileoverview Create a new automatic categorization rule in PocketSmith
 * Creates rules to automatically categorize transactions based on payee name patterns.
 * Supports pattern matching against payee names for flexible transaction categorization.
 * Rules can optionally be applied retroactively to existing transactions.
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

export const CreateCategoryRuleInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  categoryId: z.number().int().describe("ID of the category to assign to matching transactions"),
  payeeMatches: z.string().describe("Pattern to match against payee names (supports partial matches)"),
  applyToUncategorised: z.boolean().optional().default(false).describe("Apply rule to all uncategorised transactions"),
  applyToAll: z.boolean().optional().default(false).describe("Apply rule to all transactions"),
});

export type CreateCategoryRuleInput = z.infer<typeof CreateCategoryRuleInputSchema>;

export const CreateCategoryRuleResponseSchema = z.object({
  rule: z.object({
    id: z.number(),
    category_id: z.number(),
    category_title: z.string().optional(),
    payee_matches: z.string().optional(),
    created_at: z.string().optional(),
  }).describe("The created categorization rule"),
  success: z.boolean().describe("Whether the rule was created successfully"),
  message: z.string().describe("Success message describing the rule"),
});

export type CreateCategoryRuleResponse = z.infer<typeof CreateCategoryRuleResponseSchema>;

export async function createCategoryRuleLogic(
  params: CreateCategoryRuleInput,
  context: RequestContext,
): Promise<CreateCategoryRuleResponse> {
  logger.debug("Processing create category rule request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Validate category exists and get its title
  let categoryTitle: string | undefined;
  try {
    const categories = await service.getCategories(user.id!, context);
    const targetCategory = categories.find((cat: any) => cat.id === params.categoryId);
    if (!targetCategory) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        `Category with ID ${params.categoryId} not found`
      );
    }
    categoryTitle = targetCategory.title;
  } catch (error) {
    if (error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND) {
      throw error;
    }
    // If we can't fetch categories, proceed anyway - the API will validate
  }
  
  // Build rule object with defensive programming
  const ruleData = {
    payee_matches: params.payeeMatches,
    apply_to_uncategorised: params.applyToUncategorised,
    apply_to_all: params.applyToAll,
  };
  
  // Create the category rule
  const rule = await service.createCategoryRule(
    params.categoryId,
    ruleData,
    context
  );

  // Build descriptive message about the rule
  const conditionsText = `payee contains "${params.payeeMatches}"`;
  const categoryText = categoryTitle ? `"${categoryTitle}"` : `category ${params.categoryId}`;
  
  const response: CreateCategoryRuleResponse = {
    rule: {
      id: rule.id ?? 0,
      category_id: rule.category?.id ?? params.categoryId,
      category_title: categoryTitle,
      payee_matches: rule.payee_matches,
      created_at: rule.created_at,
    },
    success: true,
    message: `Successfully created categorization rule: transactions where ${conditionsText} will be automatically assigned to ${categoryText}`,
  };

  logger.debug("Create category rule processed successfully", {
    ...context,
    ruleId: rule.id,
    categoryId: params.categoryId,
  });

  return response;
}

export const registerCreateCategoryRuleTool = async (server: McpServer): Promise<void> => {
  const toolName = "create_category_rule";
  const toolDescription = "Create a new automatic categorization rule in PocketSmith";

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
          title: "Create PocketSmith Category Rule",
          description: toolDescription,
          inputSchema: CreateCategoryRuleInputSchema.shape,
          outputSchema: CreateCategoryRuleResponseSchema.shape,
          annotations: {
            readOnlyHint: false,
            openWorldHint: false,
          },
        },
        async (params: CreateCategoryRuleInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await createCategoryRuleLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "createCategoryRuleHandler",
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
