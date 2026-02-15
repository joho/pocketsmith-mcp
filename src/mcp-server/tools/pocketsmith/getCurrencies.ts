/**
 * @fileoverview Get available currencies from PocketSmith
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

export const GetCurrenciesInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetCurrenciesInput = z.infer<typeof GetCurrenciesInputSchema>;

export const GetCurrenciesResponseSchema = z.object({
  currencies: z.array(z.object({
    code: z.string(),
    name: z.string(),
    symbol: z.string().nullable(),
    minor_unit: z.number().optional(),
    separators: z.object({
      major: z.string().optional(),
      minor: z.string().optional(),
    }).optional(),
  })).describe("List of available currencies"),
  totalCount: z.number().describe("Total number of currencies available"),
});

export type GetCurrenciesResponse = z.infer<typeof GetCurrenciesResponseSchema>;

export async function getCurrenciesLogic(
  params: GetCurrenciesInput,
  context: RequestContext,
): Promise<GetCurrenciesResponse> {
  logger.debug("Processing get currencies request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get currencies
  const currencies = await service.getCurrencies(context);

  // Process currencies
  const processedCurrencies = currencies.map(currency => ({
    code: currency.id ?? '',
    name: currency.name ?? '',
    symbol: currency.symbol ?? null,
    minor_unit: currency.minor_unit,
    separators: currency.separators ? {
      major: currency.separators.major,
      minor: currency.separators.minor,
    } : undefined,
  }));

  const response: GetCurrenciesResponse = {
    currencies: processedCurrencies,
    totalCount: currencies.length,
  };

  logger.debug("Get currencies processed successfully", {
    ...context,
    currencyCount: currencies.length,
  });

  return response;
}

export const registerGetCurrenciesTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_currencies";
  const toolDescription = "Get list of available currencies supported by PocketSmith";

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
          title: "Get PocketSmith Currencies",
          description: toolDescription,
          inputSchema: GetCurrenciesInputSchema.shape,
          outputSchema: GetCurrenciesResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetCurrenciesInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getCurrenciesLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getCurrenciesHandler",
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
