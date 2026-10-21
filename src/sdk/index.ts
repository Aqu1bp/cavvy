// Harness's TypeScript SDK: drive the harness from your own code.
//
//     import { query, tool } from "my-own-harness/sdk";
//
// See src/sdk/README.md. Runs in Bun, in your process, with the same keys,
// settings, sessions, MCP servers and hooks as the `harness` CLI.

export { query, type Query } from "./query";
export { tool, type SdkTool, type SdkToolContext, type SdkToolOptions, type SdkToolResult, type JsonSchema } from "./tool";
export { HarnessSdkError } from "./errors";
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
