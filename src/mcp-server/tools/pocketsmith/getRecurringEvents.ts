/**
 * @fileoverview Get recurring events (scheduled transactions) from PocketSmith
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

export const GetRecurringEventsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
  startDate: z.string().describe("Start date for events range (YYYY-MM-DD)"),
  endDate: z.string().describe("End date for events range (YYYY-MM-DD)"),
});

export type GetRecurringEventsInput = z.infer<typeof GetRecurringEventsInputSchema>;

export const GetRecurringEventsResponseSchema = z.object({
  events: z.array(z.object({
    id: z.string(),
    amount: z.number(),
    date: z.string(),
    repeat_type: z.string(),
    repeat_interval: z.number(),
    currency_code: z.string().optional(),
    colour: z.string().nullable(),
    category: z.object({
      id: z.number(),
      title: z.string(),
    }).optional(),
    scenario: z.object({
      id: z.number(),
      title: z.string(),
    }).optional(),
    note: z.string().nullable(),
    is_debit: z.boolean(),
  })).describe("List of recurring events"),
  summary: z.object({
    totalEvents: z.number(),
    totalDebitEvents: z.number(),
    totalCreditEvents: z.number(),
    averageAmount: z.number(),
    dateRange: z.string(),
  }).describe("Summary of recurring events"),
});

export type GetRecurringEventsResponse = z.infer<typeof GetRecurringEventsResponseSchema>;

export async function getRecurringEventsLogic(
  params: GetRecurringEventsInput,
  context: RequestContext,
): Promise<GetRecurringEventsResponse> {
  logger.debug("Processing get recurring events request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get recurring events
  const events = await service.getRecurringEvents(user.id!, params.startDate, params.endDate, context);

  // Process events
  const processedEvents = events.map(event => ({
    id: event.id ?? '',
    amount: event.amount ?? 0,
    date: event.date ?? '',
    repeat_type: event.repeat_type ?? '',
    repeat_interval: event.repeat_interval ?? 1,
    currency_code: event.currency_code,
    colour: event.colour ?? null,
    category: event.category ? {
      id: event.category.id ?? 0,
      title: event.category.title ?? '',
    } : undefined,
    scenario: event.scenario ? {
      id: event.scenario.id ?? 0,
      title: event.scenario.title ?? '',
    } : undefined,
    note: event.note ?? null,
    is_debit: event.amount ? event.amount < 0 : false,
  }));

  // Calculate summary
  const totalEvents = processedEvents.length;
  const debitEvents = processedEvents.filter(e => e.is_debit);
  const creditEvents = processedEvents.filter(e => !e.is_debit);
  const averageAmount = totalEvents > 0 
    ? processedEvents.reduce((sum, e) => sum + Math.abs(e.amount), 0) / totalEvents 
    : 0;

  const response: GetRecurringEventsResponse = {
    events: processedEvents,
    summary: {
      totalEvents,
      totalDebitEvents: debitEvents.length,
      totalCreditEvents: creditEvents.length,
      averageAmount,
      dateRange: `${params.startDate} to ${params.endDate}`,
    },
  };

  logger.debug("Get recurring events processed successfully", {
    ...context,
    eventCount: events.length,
    debitCount: debitEvents.length,
    creditCount: creditEvents.length,
  });

  return response;
}

export const registerGetRecurringEventsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_recurring_events";
  const toolDescription = "Get recurring events (scheduled transactions) from PocketSmith for a date range";

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
          title: "Get PocketSmith Recurring Events",
          description: toolDescription,
          inputSchema: GetRecurringEventsInputSchema.shape,
          outputSchema: GetRecurringEventsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetRecurringEventsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getRecurringEventsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getRecurringEventsHandler",
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
