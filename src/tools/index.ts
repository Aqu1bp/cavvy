import type { Tool } from "./types";
import type { ToolSchema } from "../providers/types";
import type { Settings } from "../config/settings";
import { ReadTool, WriteTool, EditTool, MultiEditTool, NotebookEditTool } from "./file-tools";
import { BashTool, BashOutputTool, KillShellTool } from "./bash";
import { MonitorTool } from "./monitor";
import { BROWSER_TOOLS } from "./browser-tools";
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
    ...BROWSER_TOOLS,
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

/** Whether a tool is offered under these settings (WebSearch needs a backend, the Browser tools a browser). */
export function offered(t: Tool<any>, settings: Settings): boolean {
    return t.enabled?.({ settings }) !== false;
}

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
    $ref?: string;
    anyOf?: (PropertySchema | boolean)[];
    oneOf?: (PropertySchema | boolean)[];
    allOf?: (PropertySchema | boolean)[];
    not?: PropertySchema | boolean;
}

/** A property schema we can read: an object or a boolean. MCP servers can send anything else. */
function isSchema(prop: unknown): prop is PropertySchema | boolean {
    return typeof prop === "boolean" || (prop !== null && typeof prop === "object" && !Array.isArray(prop));
}

/** Whether a schema accepts null: yes, no, or unknown (a malformed schema, or a $ref we can't resolve). */
type NullVerdict = boolean | undefined;

/** Every verdict must hold: one "no" decides it, otherwise any unknown leaves it unknown. */
function every(verdicts: NullVerdict[]): NullVerdict {
    if (verdicts.includes(false)) return false;
    return verdicts.includes(undefined) ? undefined : true;
}

/** A local $ref ("#", "#/definitions/X", "#/$defs/X", any JSON pointer) resolved in the tool's root schema. */
function resolveRef(root: unknown, ref: string): unknown {
    if (!ref.startsWith("#")) return undefined; // remote: unknown
    let pointer: string;
    try {
        pointer = decodeURIComponent(ref.slice(1));
    } catch {
        return undefined;
    }
    if (pointer === "") return root;
    if (!pointer.startsWith("/")) return undefined; // an $anchor name: unknown
    let node: unknown = root;
    for (const raw of pointer.slice(1).split("/")) {
        const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        if (node === null || typeof node !== "object" || !Object.hasOwn(node, part)) return undefined;
        node = (node as Record<string, unknown>)[part];
    }
    return node;
}

/**
 * Null is a value, not a missing key; check the constraints that can exclude it.
 * Local $refs are followed in `root`; a malformed schema, a remote or missing
 * $ref, or a cycle is unknown, which never rejects or drops a value.
 */
function allowsNull(prop: unknown, root: unknown, seen: ReadonlySet<string> = new Set()): NullVerdict {
    if (!isSchema(prop)) return undefined;
    if (typeof prop === "boolean") return prop;
    const verdicts: NullVerdict[] = [];
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    if (types.length && !types.includes("null") && !prop.nullable) return false;
    if (Array.isArray(prop.enum) && !prop.enum.includes(null)) return false;
    if ("const" in prop && prop.const !== null) return false;
    if (typeof prop.$ref === "string") {
        if (seen.has(prop.$ref)) verdicts.push(undefined);
        else verdicts.push(allowsNull(resolveRef(root, prop.$ref), root, new Set([...seen, prop.$ref])));
    }
    const sub = (list: unknown) => (Array.isArray(list) ? list.map((s) => allowsNull(s, root, seen)) : undefined);
    const anyOf = sub(prop.anyOf);
    if (anyOf) verdicts.push(anyOf.includes(true) ? true : anyOf.includes(undefined) ? undefined : false);
    const oneOf = sub(prop.oneOf);
    if (oneOf) {
        const yes = oneOf.filter((v) => v === true).length;
        const maybe = oneOf.filter((v) => v === undefined).length;
        verdicts.push(yes > 1 || yes + maybe === 0 ? false : maybe ? undefined : true);
    }
    const allOf = sub(prop.allOf);
    if (allOf) verdicts.push(every(allOf));
    if (prop.not !== undefined && isSchema(prop.not)) {
        const inner = allowsNull(prop.not, root, seen);
        verdicts.push(inner === undefined ? undefined : !inner);
    }
    return every(verdicts);
}

/**
 * An optional key whose null the schema certainly forbids. Models often send
 * null for parameters they don't use; that means "omitted", so the key is dropped.
 */
function isOmittedNull(t: Tool<any>, key: string, val: unknown): boolean {
    if (val !== null) return false;
    const schema = (t.parameters ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.includes(key)) return false;
    const props = schema.properties ?? {};
    return Object.hasOwn(props, key) && allowsNull(props[key], t.parameters) === false;
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
        const prop: unknown = schema.properties?.[key];
        if (val === undefined || !isSchema(prop)) continue;
        if (val === null) {
            if (allowsNull(prop, t.parameters) === false && !isOmittedNull(t, key, val)) return `Parameter "${key}" does not allow null`;
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
        if (Array.isArray(prop.enum) && !prop.enum.includes(val)) return `Parameter "${key}" must be one of ${prop.enum.map((e) => JSON.stringify(e)).join(", ")}`;
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
 * An optional key set to a null its schema forbids is dropped, as if omitted,
 * so tools (and MCP servers) get arguments their schema accepts.
 */
export function coerceInput(t: Tool<any>, input: Record<string, unknown>): Record<string, unknown> {
    const props = (t.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
    const out: Record<string, unknown> = { ...input };
    for (const [k, v] of Object.entries(out)) {
        if (isOmittedNull(t, k, v)) {
            delete out[k];
            continue;
        }
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
