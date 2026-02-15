/**
 * @fileoverview Get budget analysis from PocketSmith
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

export const GetBudgetsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetBudgetsInput = z.infer<typeof GetBudgetsInputSchema>;

export const GetBudgetsResponseSchema = z.object({
  budgetAnalysis: z.array(z.object({
    category: z.object({
      id: z.number(),
      title: z.string(),
    }),
    budget: z.number().optional(),
    actual: z.number(),
    difference: z.number(),
    percentage: z.number().optional(),
    period: z.string().optional(),
  })).describe("Budget analysis by category"),
  summary: z.object({
    totalBudgeted: z.number(),
    totalActual: z.number(),
    totalDifference: z.number(),
    categoriesOverBudget: z.number(),
    categoriesUnderBudget: z.number(),
  }).describe("Budget summary"),
});

export type GetBudgetsResponse = z.infer<typeof GetBudgetsResponseSchema>;

export async function getBudgetsLogic(
  params: GetBudgetsInput,
  context: RequestContext,
): Promise<GetBudgetsResponse> {
  logger.debug("Processing get budgets request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get budget analysis
  const budgetData = await service.getBudgets(user.id ?? 0, context);

  // Process budget analysis
  const budgetAnalysis = budgetData.map((item: any) => {
    // Use available properties from the budget response
    const actual = item.expense?.total_actual_amount || 0;
    // Use periods data for budget information if available
    const latestPeriod = item.expense?.periods?.[0];
    const budget = latestPeriod?.forecast_amount || 0;
    const difference = budget - actual;
    const percentage = budget > 0 ? (actual / budget) * 100 : undefined;

    return {
      category: {
        id: item.category?.id ?? 0,
        title: item.category?.title ?? '',
      },
      budget: budget > 0 ? budget : undefined,
      actual,
      difference,
      percentage,
      period: item.expense?.start_date && item.expense?.end_date ? `${item.expense.start_date} to ${item.expense.end_date}` : undefined,
    };
  });

  // Calculate summary
  let totalBudgeted = 0;
  let totalActual = 0;
  let categoriesOverBudget = 0;
  let categoriesUnderBudget = 0;

  budgetAnalysis.forEach((item: any) => {
    if (item.budget) {
      totalBudgeted += item.budget;
      if (item.actual > item.budget) {
        categoriesOverBudget++;
      } else {
        categoriesUnderBudget++;
      }
    }
    totalActual += item.actual;
  });

  const response: GetBudgetsResponse = {
    budgetAnalysis,
    summary: {
      totalBudgeted,
      totalActual,
      totalDifference: totalBudgeted - totalActual,
      categoriesOverBudget,
      categoriesUnderBudget,
    },
  };

  logger.debug("Get budgets processed successfully", {
    ...context,
    budgetItems: budgetAnalysis.length,
    totalBudgeted,
    totalActual,
  });

  return response;
}

export const registerGetBudgetsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_budgets";
  const toolDescription = "Get budget analysis from PocketSmith showing budget vs actual spending by category";

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
          title: "Get PocketSmith Budget Analysis",
          description: toolDescription,
          inputSchema: GetBudgetsInputSchema.shape,
          outputSchema: GetBudgetsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetBudgetsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getBudgetsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getBudgetsHandler",
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
