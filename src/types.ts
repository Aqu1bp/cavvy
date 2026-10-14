
export type ToolCall = {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

export type UserMessage = {
    role: "user";
    content: string;
};

export type AssistantMessage = {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
};

export type ToolMessage = {
    role: "tool";
    tool_call_id: string;
    content: string;
};

export type Message = UserMessage | AssistantMessage | ToolMessage;

export type ChatResponse = {
    choices: {
        message: AssistantMessage;
        finish_reason: string;
    }[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
    };
}