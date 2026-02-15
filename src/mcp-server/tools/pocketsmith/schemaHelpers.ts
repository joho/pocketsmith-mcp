/**
 * @fileoverview Reusable schema helpers for nullable PocketSmith API fields
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Type-safe wrapper around server.registerTool that avoids TS2589
 * "Type instantiation is excessively deep and possibly infinite" errors.
 *
 * The MCP SDK's registerTool generic inference creates excessively deep
 * type instantiation when used with Zod schema shapes, causing OOM during
 * compilation when many tools are registered.
 */
export function registerTool(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (...args: any[]) => any,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server.registerTool as any)(name, config, cb);
}

/**
 * Creates a nullable field schema that accepts both the type and null
 */
export const createNullableField = <T extends z.ZodTypeAny>(
  baseType: T,
  description: string
) => {
  return z.union([baseType, z.null()]).describe(description);
};

/**
 * Creates an optional nullable field schema
 */
export const createOptionalNullableField = <T extends z.ZodTypeAny>(
  baseType: T,
  description: string
) => {
  return createNullableField(baseType, description).optional();
};

/**
 * Common nullable field definitions used across PocketSmith tools
 */
export const NULLABLE_FIELDS = {
  // Category-related fields
  parent_id: createOptionalNullableField(z.coerce.number().int(), "Parent category ID"),
  category_id: createOptionalNullableField(z.coerce.number().int(), "Category ID"),
  colour: createOptionalNullableField(z.string(), "Color (hex format)"),
  
  // Transaction-related fields
  note: createOptionalNullableField(z.string(), "Notes"),
  memo: createOptionalNullableField(z.string(), "Memo"),
  
  // Account-related fields
  safe_balance: createOptionalNullableField(z.number(), "Safe balance"),
  current_balance_exchange_rate: createOptionalNullableField(z.number(), "Exchange rate"),
  safe_balance_in_base_currency: createOptionalNullableField(z.number(), "Safe balance in base currency"),
  
  // General metadata fields
  updated_at: createOptionalNullableField(z.string(), "Last update timestamp"),
  created_at: createOptionalNullableField(z.string(), "Creation timestamp"),
  symbol: createOptionalNullableField(z.string(), "Symbol"),
  description: createOptionalNullableField(z.string(), "Description"),
  
  // Account number (often null for some account types)
  number: createOptionalNullableField(z.string(), "Account number"),
};

/**
 * Required nullable fields (not optional, but can be null)
 */
export const REQUIRED_NULLABLE_FIELDS = {
  // Category-related fields that are always present but can be null
  parent_id: createNullableField(z.coerce.number().int(), "Parent category ID"),
  colour: createNullableField(z.string(), "Color (hex format)"),
  
  // Transaction-related fields that are always present but can be null
  note: createNullableField(z.string(), "Notes"),
  memo: createNullableField(z.string(), "Memo"),
  
  // Account-related fields
  safe_balance: createNullableField(z.number(), "Safe balance"),
  current_balance_exchange_rate: createNullableField(z.number(), "Exchange rate"),
  safe_balance_in_base_currency: createNullableField(z.number(), "Safe balance in base currency"),
  number: createNullableField(z.string(), "Account number"),
};

/**
 * Helper function to clean up data to match nullable schemas
 */
export function cleanNullableFields<T extends Record<string, unknown>>(
  data: T,
  fieldNames: (keyof T)[]
): T {
  const cleaned = { ...data };
  
  fieldNames.forEach(field => {
    // Convert undefined to null for explicit nullable fields
    if (cleaned[field] === undefined) {
      cleaned[field] = null as T[keyof T];
    }
  });
  
  return cleaned;
}

/**
 * Helper to validate that nullable fields are properly handled
 */
export function validateNullableField(
  value: unknown,
  field: string,
  allowNull: boolean = true
): unknown {
  if (value === null && !allowNull) {
    throw new Error(`Field ${field} cannot be null`);
  }
  
  if (value === undefined && allowNull) {
    return null;
  }
  
  return value;
}


