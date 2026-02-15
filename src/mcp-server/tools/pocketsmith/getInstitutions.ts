/**
 * @fileoverview Get user's financial institutions from PocketSmith
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

export const GetInstitutionsInputSchema = z.object({
  apiKey: z.string().optional().describe("PocketSmith API key (if not set via environment)"),
  accessToken: z.string().optional().describe("OAuth access token (if not using API key)"),
});

export type GetInstitutionsInput = z.infer<typeof GetInstitutionsInputSchema>;

export const GetInstitutionsResponseSchema = z.object({
  institutions: z.array(z.object({
    id: z.number(),
    title: z.string(),
    currency_code: z.string(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })).describe("List of user's financial institutions"),
  totalCount: z.number().describe("Total number of institutions"),
});

export type GetInstitutionsResponse = z.infer<typeof GetInstitutionsResponseSchema>;

export async function getInstitutionsLogic(
  params: GetInstitutionsInput,
  context: RequestContext,
): Promise<GetInstitutionsResponse> {
  logger.debug("Processing get institutions request", {
    ...context,
    toolInput: params,
  });

  const apiKey = params.apiKey || process.env.POCKETSMITH_API_KEY;
  const accessToken = params.accessToken || process.env.POCKETSMITH_ACCESS_TOKEN;

  const service = new PocketSmithService(apiKey, accessToken);
  
  // Get current user first
  const user = await service.getCurrentUser(context);
  
  // Get institutions
  const institutions = await service.getInstitutions(user.id!, context);

  // Process institutions
  const processedInstitutions = institutions.map(institution => ({
    id: institution.id ?? 0,
    title: institution.title ?? '',
    currency_code: institution.currency_code ?? '',
    created_at: institution.created_at,
    updated_at: institution.updated_at,
  }));

  const response: GetInstitutionsResponse = {
    institutions: processedInstitutions,
    totalCount: institutions.length,
  };

  logger.debug("Get institutions processed successfully", {
    ...context,
    institutionCount: institutions.length,
  });

  return response;
}

export const registerGetInstitutionsTool = async (server: McpServer): Promise<void> => {
  const toolName = "get_institutions";
  const toolDescription = "Get user's financial institutions from PocketSmith";

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
          title: "Get PocketSmith Institutions",
          description: toolDescription,
          inputSchema: GetInstitutionsInputSchema.shape,
          outputSchema: GetInstitutionsResponseSchema.shape,
          annotations: {
            readOnlyHint: true,
            openWorldHint: false,
          },
        },
        async (params: GetInstitutionsInput) => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentRequestId: registrationContext.requestId,
              operation: "HandleToolRequest",
              toolName: toolName,
              input: params,
            });

          try {
            const result = await getInstitutionsLogic(params, handlerContext);
            return {
              structuredContent: result,
              content: [
                { type: "text", text: JSON.stringify(result, null, 2) },
              ],
            };
          } catch (error) {
            const mcpError = ErrorHandler.handleError(error, {
              operation: "getInstitutionsHandler",
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
