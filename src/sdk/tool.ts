// tool(): a tool of the SDK user's own, run in their process.

export type JsonSchema = Record<string, unknown>;

export interface SdkToolContext {
    /** Ends when the turn is interrupted or the query closed. */
    signal: AbortSignal;
    /** The session's working folder. */
    cwd: string;
}

/** What a handler returns: text for the model, or that with an error flag. */
export type SdkToolResult = string | { content: string; isError?: boolean };

export interface SdkToolOptions {
    /** Safe to run alongside other read-only calls. Default false. */
    readOnly?: boolean;
    /** How a call reads in the transcript. Default: the tool's name. */
    title?: (input: any) => string;
}

export interface SdkTool<I = any> {
    readonly kind: "sdk-tool";
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchema;
    readonly handler: (input: I, context: SdkToolContext) => Promise<SdkToolResult> | SdkToolResult;
    readonly options: SdkToolOptions;
}

/** Names the model can call: what the providers accept. */
export const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * A tool the model can call, run in this process. `inputSchema` is a JSON
 * Schema object for the input. Calls run without a permission prompt (you
 * wrote the tool), but deny rules (`disallowedTools`) still apply. A thrown
 * error becomes an error result the model sees.
 */
export function tool<I = any>(name: string, description: string, inputSchema: JsonSchema, handler: SdkTool<I>["handler"], options: SdkToolOptions = {}): SdkTool<I> {
    if (!TOOL_NAME.test(name)) throw new TypeError(`tool(): "${name}" isn't a valid tool name (letters, digits, _ and -, starting with a letter, at most 64).`);
    if (typeof handler !== "function") throw new TypeError(`tool(): the handler for "${name}" isn't a function.`);
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) throw new TypeError(`tool(): the input schema for "${name}" must be a JSON Schema object.`);
    return { kind: "sdk-tool", name, description, inputSchema: inputSchema.type ? inputSchema : { type: "object", ...inputSchema }, handler, options };
}
