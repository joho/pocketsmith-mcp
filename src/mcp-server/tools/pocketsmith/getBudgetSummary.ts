/**
 * @fileoverview Get budget summary with period analysis from PocketSmith
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

export const GetBudgetSummaryInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  period: z.enum(["weeks", "months", "years"]).describe("Period to analyze (weeks, months, or years)"),
  interval: z.number().int().min(1).describe("Period interval (e.g., 2 for fortnightly if period is weeks)"),
  startDate: z.string().describe("Start date for analysis (YYYY-MM-DD)"),
  endDate: z.string().describe("End date for analysis (YYYY-MM-DD)"),
});

export type GetBudgetSummaryInput = z.infer<typeof GetBudgetSummaryInputSchema>;

export const GetBudgetSummaryResponseSchema = z.object({
  budgetSummary: z.array(z.object({
    category: z.object({
      id: z.number(),
      title: z.string(),
    }),
    periods: z.array(z.object({
      period_label: z.string(),
      budget_amount: z.number(),
      actual_amount: z.number(),
      difference: z.number(),
      percentage_used: z.number(),
    })),
    overall: z.object({
      total_budget: z.number(),
      total_actual: z.number(),
      total_difference: z.number(),
      average_percentage: z.number(),
    }),
  })).describe("Budget analysis by category and period"),
  summary: z.object({
    analysis_period: z.string(),
    total_periods: z.number(),
    overall_budget: z.number(),
    overall_actual: z.number(),
    overall_difference: z.number(),
    overall_percentage: z.number(),
    categories_over_budget: z.number(),
    categories_under_budget: z.number(),
  }).describe("Overall budget summary"),
});

export type GetBudgetSummaryResponse = z.infer<typeof GetBudgetSummaryResponseSchema>;

export async function getBudgetSummaryLogic(
  params: GetBudgetSummaryInput,
  context: RequestContext,
): Promise<GetBudgetSummaryResponse> {
  logger.debug("Processing get budget summary request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get budget summary
  const budgetData = await service.getBudgetSummary(
    user.id!,
    {
      period: params.period,
      interval: params.interval,
      startDate: params.startDate,
      endDate: params.endDate,
    },
    context
  );

  // Process budget data
  const processedBudgetSummary = budgetData.map((categoryData: Record<string, unknown>) => {
    const periodsArray = categoryData.periods as Record<string, unknown>[] | undefined;
    const periods = periodsArray?.map((period: Record<string, unknown>) => {
      const budgetAmount = (period.budget_amount as number) || 0;
      const actualAmount = (period.actual_amount as number) || 0;
      
      return {
        period_label: (period.period_label as string) || 'Unknown',
        budget_amount: budgetAmount,
        actual_amount: actualAmount,
        difference: budgetAmount - actualAmount,
        percentage_used: budgetAmount > 0 
          ? Math.round((actualAmount / budgetAmount) * 100)
          : 0,
      };
    }) || [];

    const totalBudget = periods.reduce((sum: number, p) => sum + p.budget_amount, 0);
    const totalActual = periods.reduce((sum: number, p) => sum + p.actual_amount, 0);
    const totalDifference = totalBudget - totalActual;
    const averagePercentage = totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0;

    const category = categoryData.category as Record<string, unknown> | undefined;
    
    return {
      category: {
        id: (category?.id as number) ?? 0,
        title: (category?.title as string) ?? 'Unknown',
      },
      periods,
      overall: {
        total_budget: totalBudget,
        total_actual: totalActual,
        total_difference: totalDifference,
        average_percentage: averagePercentage,
      },
    };
  });

  // Calculate overall summary
  const totalPeriods = processedBudgetSummary[0]?.periods.length || 0;
  const overallBudget = processedBudgetSummary.reduce((sum: number, cat: any) => sum + cat.overall.total_budget, 0);
  const overallActual = processedBudgetSummary.reduce((sum: number, cat: any) => sum + cat.overall.total_actual, 0);
  const overallDifference = overallBudget - overallActual;
  const overallPercentage = overallBudget > 0 ? Math.round((overallActual / overallBudget) * 100) : 0;

  const categoriesOverBudget = processedBudgetSummary.filter(
    (cat: any) => cat.overall.total_actual > cat.overall.total_budget
  ).length;
  const categoriesUnderBudget = processedBudgetSummary.filter(
    (cat: any) => cat.overall.total_actual <= cat.overall.total_budget && cat.overall.total_budget > 0
  ).length;

  const response: GetBudgetSummaryResponse = {
    budgetSummary: processedBudgetSummary,
    summary: {
      analysis_period: `${params.period} (interval: ${params.interval})`,
      total_periods: totalPeriods,
      overall_budget: overallBudget,
      overall_actual: overallActual,
      overall_difference: overallDifference,
      overall_percentage: overallPercentage,
      categories_over_budget: categoriesOverBudget,
      categories_under_budget: categoriesUnderBudget,
    },
  };

  logger.debug("Get budget summary processed successfully", {
    ...context,
    categoryCount: processedBudgetSummary.length,
    totalPeriods,
    overallBudget,
    overallActual,
  });

  return response;
}

export const registerGetBudgetSummaryTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_budget_summary";
  const toolDescription = "Get detailed budget summary with period analysis (weeks/months/years)";

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
          title: "Get PocketSmith Budget Summary",
          description: toolDescription,
          inputSchema: GetBudgetSummaryInputSchema.shape,
          outputSchema: GetBudgetSummaryResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetBudgetSummaryInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getBudgetSummaryLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getBudgetSummaryHandler",
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
