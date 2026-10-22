import type { Tool } from "./types";
import type { ToolSchema } from "../providers/types";
import { ReadTool, WriteTool, EditTool, MultiEditTool, NotebookEditTool } from "./file-tools";
import { BashTool, BashOutputTool, KillShellTool } from "./bash";
import { MonitorTool } from "./monitor";
import { GlobTool, GrepTool, LSTool } from "./search-tools";
import { WebFetchTool, WebSearchTool } from "./web-tools";
import { GitCommitTool, GitPushTool, CreatePullRequestTool, WatchPullRequestTool, UnwatchPullRequestTool } from "./git-tools";
import { TodoWriteTool, ExitPlanModeTool, AskUserQuestionTool, RequestSecretTool, TaskTool, TaskStatusTool, ListModelsTool } from "./meta-tools";

export const BUILTIN_TOOLS: Tool<any>[] = [
    TaskTool,
    TaskStatusTool,
    ListModelsTool,
    BashTool,
    BashOutputTool,
    KillShellTool,
    MonitorTool,
    GlobTool,
    GrepTool,
    LSTool,
    ReadTool,
    EditTool,
    MultiEditTool,
    WriteTool,
    NotebookEditTool,
    WebFetchTool,
    WebSearchTool,
    GitCommitTool,
    GitPushTool,
    CreatePullRequestTool,
    WatchPullRequestTool,
    UnwatchPullRequestTool,
    TodoWriteTool,
    AskUserQuestionTool,
    RequestSecretTool,
    ExitPlanModeTool,
];

/** Tools a read-only "explore" sub-agent may use. */
export const EXPLORE_TOOLS = new Set(["Glob", "Grep", "LS", "Read", "WebFetch", "WebSearch", "Bash", "BashOutput"]);

export function toSchema(t: Tool<any>): ToolSchema {
    return { name: t.name, description: t.description, parameters: t.parameters };
}

interface PropertySchema {
    type?: string | string[];
    nullable?: boolean;
    enum?: unknown[];
    const?: unknown;
    anyOf?: (PropertySchema | boolean)[];
    oneOf?: (PropertySchema | boolean)[];
    allOf?: (PropertySchema | boolean)[];
    not?: PropertySchema | boolean;
}

/** Null is a value, not a missing key; check the constraints that can exclude it. */
function allowsNull(prop: PropertySchema | boolean): boolean {
    if (typeof prop === "boolean") return prop;
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    if (types.length && !types.includes("null") && !prop.nullable) return false;
    if (prop.enum && !prop.enum.includes(null)) return false;
    if ("const" in prop && prop.const !== null) return false;
    if (prop.anyOf && !prop.anyOf.some(allowsNull)) return false;
    if (prop.oneOf && prop.oneOf.filter(allowsNull).length !== 1) return false;
    if (prop.allOf && !prop.allOf.every(allowsNull)) return false;
    if (prop.not !== undefined && allowsNull(prop.not)) return false;
    return true;
}

/**
 * Minimal JSON-Schema check for tool input: required keys and top-level
 * primitive types. Catches truncated or malformed calls before they run.
 */
export function validateInput(t: Tool<any>, input: unknown): string | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "Tool input must be a JSON object";
    const obj = input as Record<string, unknown>;
    if ("__invalid_json" in obj) return `The tool arguments were not valid JSON: ${String(obj.__invalid_json).slice(0, 200)}`;
    const schema = t.parameters as { properties?: Record<string, PropertySchema | boolean>; required?: string[] };
    for (const key of schema.required ?? []) {
        if (!Object.hasOwn(obj, key) || obj[key] === undefined) return `Missing required parameter "${key}"`;
    }
    for (const [key, val] of Object.entries(obj)) {
        const prop = schema.properties?.[key];
        if (prop === undefined || val === undefined) continue;
        if (val === null) {
            if (!allowsNull(prop)) return `Parameter "${key}" does not allow null`;
            continue;
        }
        if (typeof prop === "boolean") {
            if (!prop) return `Parameter "${key}" is not allowed`;
            continue;
        }
        const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
        if (types.length && !types.some((ty) => typeMatches(ty, val))) {
            return `Parameter "${key}" should be ${types.join(" or ")}, got ${Array.isArray(val) ? "array" : typeof val}`;
        }
        if (prop.enum && !prop.enum.includes(val)) return `Parameter "${key}" must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(", ")}`;
    }
    return undefined;
}

function typeMatches(ty: string, v: unknown): boolean {
    switch (ty) {
        case "string":
            return typeof v === "string";
        case "number":
            return typeof v === "number" && Number.isFinite(v);
        case "integer":
            return typeof v === "number" && Number.isInteger(v);
        case "boolean":
            return typeof v === "boolean";
        case "array":
            return Array.isArray(v);
        case "object":
            return v !== null && typeof v === "object" && !Array.isArray(v);
        case "null":
            return v === null;
        default:
            return true;
    }
}

/**
 * Models sometimes send numbers/booleans as strings. Coerce top-level values
 * where the schema is unambiguous, so a "30000" timeout doesn't fail the call.
 */
export function coerceInput(t: Tool<any>, input: Record<string, unknown>): Record<string, unknown> {
    const props = (t.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
    const out: Record<string, unknown> = { ...input };
    for (const [k, v] of Object.entries(out)) {
        const ty = props[k]?.type;
        if (typeof v !== "string") continue;
        if ((ty === "number" || ty === "integer") && /^-?\d+(\.\d+)?$/.test(v.trim())) out[k] = Number(v);
        else if (ty === "boolean" && (v === "true" || v === "false")) out[k] = v === "true";
        else if ((ty === "array" || ty === "object") && /^[[{]/.test(v.trim())) {
            try {
                out[k] = JSON.parse(v);
            } catch {
                // leave as is; validation reports it
            }
        }
    }
    return out;
}
