/**
 * @fileoverview Get automatic categorization rules from PocketSmith
 * Retrieves all automatic categorization rules for a user, which define how
 * transactions are automatically categorized based on payee name patterns.
 * Rules match against transaction payee names and automatically assign categories.
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

export const GetCategoryRulesInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetCategoryRulesInput = z.infer<typeof GetCategoryRulesInputSchema>;

export const GetCategoryRulesResponseSchema = z.object({
  rules: z.array(z.object({
    id: z.number(),
    category_id: z.number(),
    category_title: z.string().optional(),
    payee_matches: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })).describe("List of automatic categorization rules"),
  summary: z.object({
    totalRules: z.number(),
    rulesWithPayeeMatching: z.number(),
    categoriesWithRules: z.number(),
  }).describe("Summary of categorization rules"),
});

export type GetCategoryRulesResponse = z.infer<typeof GetCategoryRulesResponseSchema>;

export async function getCategoryRulesLogic(
  params: GetCategoryRulesInput,
  context: RequestContext,
): Promise<GetCategoryRulesResponse> {
  logger.debug("Processing get category rules request", {
    ...context,
    toolInput: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get category rules
  const rules = await service.getCategoryRules(user.id ?? 0, context);

  // Get categories to enrich rule data with category titles
  let categoriesMap: Map<number, string> = new Map();
  try {
    const categories = await service.getCategories(user.id ?? 0, context);
    categoriesMap = new Map(categories.map(cat => [cat.id ?? 0, cat.title ?? '']));
  } catch (error) {
    // If we can't fetch categories, continue without titles
    logger.error("Failed to fetch categories for rule enrichment", { ...context, error });
  }

  // Process rules with defensive programming
  const processedRules = rules.map(rule => ({
    id: rule.id ?? 0,
    category_id: rule.category?.id ?? 0,
    category_title: categoriesMap.get(rule.category?.id ?? 0),
    payee_matches: rule.payee_matches,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  }));

  // Calculate summary statistics
  const summary = {
    totalRules: rules.length,
    rulesWithPayeeMatching: rules.filter(r => r.payee_matches).length,
    categoriesWithRules: new Set(rules.map(r => r.category?.id)).size,
  };

  const response: GetCategoryRulesResponse = {
    rules: processedRules,
    summary,
  };

  logger.debug("Get category rules processed successfully", {
    ...context,
    ruleCount: rules.length,
  });

  return response;
}

export const registerGetCategoryRulesTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_category_rules";
  const toolDescription = "Get automatic categorization rules from PocketSmith";

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
          title: "Get PocketSmith Category Rules",
          description: toolDescription,
          inputSchema: GetCategoryRulesInputSchema.shape,
          outputSchema: GetCategoryRulesResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetCategoryRulesInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: { ...params, apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
            });

          try {
            const result = await getCategoryRulesLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getCategoryRulesHandler",
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
