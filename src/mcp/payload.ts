// Mask server-controlled payloads without rewriting the protocol that describes them.

import type { McpServerConfig } from "../config/settings";
import type { McpCallResult } from "./client";
import { hasConfigValue, maskConfigDeep } from "./approval";

export function maskMcpResult(result: McpCallResult, config: McpServerConfig): McpCallResult {
    const mask = <T>(value: T): T => maskConfigDeep(value, config);
    return {
        ...result,
        content: result.content.map((item) => {
            switch (item.type) {
                case "text":
                    return { ...item, text: mask(item.text) };
                case "resource":
                    return { ...item, resource: { ...item.resource, text: mask(item.resource.text) } };
                case "resource_link":
                    return { ...item, name: mask(item.name), title: mask(item.title), description: mask(item.description) };
                default:
                    return item;
            }
        }),
        structuredContent: mask(result.structuredContent),
    };
}

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const SCHEMA_CHILDREN = new Set(["items", "additionalItems", "prefixItems", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "contentSchema"]);
const SCHEMA_PROSE = new Set(["title", "description", "$comment"]);

/** Redact prose only; changing a property name or a constraint would change the tool's input contract. */
export function maskMcpSchema(schema: Record<string, unknown> | undefined, config: McpServerConfig): Record<string, unknown> | undefined {
    let hidden = false;
    const containsSecret = (value: unknown, depth: number): boolean => {
        if (depth > 64) return true;
        if (typeof value === "string") return hasConfigValue(value, config);
        if (!value || typeof value !== "object") return false;
        return Object.entries(value).some(([key, child]) => hasConfigValue(key, config) || containsSecret(child, depth + 1));
    };
    const walk = (value: unknown, depth: number): unknown => {
        if (depth > 64) {
            hidden = true;
            return value;
        }
        if (Array.isArray(value)) return value.map((child) => walk(child, depth + 1));
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => {
            if (SCHEMA_PROSE.has(key) && typeof child === "string") return [key, maskConfigDeep(child, config)];
            if (SCHEMA_MAPS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
                return [key, Object.fromEntries(Object.entries(child).map(([name, sub]) => {
                    hidden ||= hasConfigValue(name, config);
                    return [name, walk(sub, depth + 1)];
                }))];
            }
            if (SCHEMA_CHILDREN.has(key)) return [key, walk(child, depth + 1)];
            // Keep protocol keywords and discriminators intact, even when a credential happens to equal one.
            if (!["type", "$schema", "format", "contentEncoding", "contentMediaType"].includes(key)) hidden ||= containsSecret(child, depth + 1);
            return [key, child];
        }));
    };
    const masked = walk(schema ?? {}, 0) as Record<string, unknown>;
    return hidden ? undefined : masked;
}
