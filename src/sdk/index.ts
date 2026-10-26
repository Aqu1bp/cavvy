// Cavvy's TypeScript SDK: drive Cavvy from your own code.
//
//     import { query, tool } from "cavvy/sdk";
//
// See src/sdk/README.md. Runs in Bun, in your process, with the same keys,
// settings, sessions, MCP servers and hooks as the `cavvy` CLI.

export { query, type Query } from "./query";
export { tool, type SdkTool, type SdkToolContext, type SdkToolOptions, type SdkToolResult, type JsonSchema } from "./tool";
export { CavvySdkError } from "./errors";
export type { CanUseTool, CanUseToolContext, Effort, Options, PermissionMode, PermissionResult, QueryParams, SDKUserMessage, Settings } from "./types";
export type {
    ResultSubtype,
    SDKAssistantMessage,
    SDKCompactMessage,
    SDKContentBlock,
    SDKMessage,
    SDKNoticeMessage,
    SDKPartialMessage,
    SDKResultMessage,
    SDKRetryMessage,
    SDKSystemInitMessage,
    SDKToolResultMessage,
} from "./messages";
