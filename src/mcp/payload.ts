// Redact schema prose without renaming properties or changing constraints.

import type { McpServerConfig } from "../config/settings";
import { hasConfigValue, maskConfigDeep } from "./approval";

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const SCHEMA_CHILDREN = new Set(["items", "additionalItems", "prefixItems", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "contentSchema"]);
const SCHEMA_PROSE = new Set(["title", "description", "$comment"]);

/** Locate prose annotations only; literal const/enum data and unknown extensions stay untouched. */
export function maskMcpSchema(schema: Record<string, unknown> | undefined, config: McpServerConfig): Record<string, unknown> | undefined {
    const prose = (value: unknown, depth: number): unknown => {
        if (depth > 64 || !value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map((child) => prose(child, depth + 1));
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
            if (SCHEMA_PROSE.has(key) && typeof child === "string") return [key, maskConfigDeep(child, config)];
            if (SCHEMA_MAPS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
                return [key, Object.fromEntries(Object.entries(child).map(([name, sub]) => [name, prose(sub, depth + 1)]))];
            }
            return [key, SCHEMA_CHILDREN.has(key) ? prose(child, depth + 1) : child];
        }));
    };
    const masked = prose(schema ?? {}, 0) as Record<string, unknown>;
    // One check covers every key and value, including dependencies and extension keywords.
    return hasConfigValue(JSON.stringify(masked), config, true) ? undefined : masked;
}
