import { readFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL;
const model = process.env.MODEL;
const apiKey = process.env.API_KEY;


type ToolCall = {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
};

type UserMessage = {
    role: "user";
    content: string;
};

type AssistantMessage = {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
};

type ToolMessage = {
    role: "tool";
    tool_call_id: string;
    content: string;
};

type Message = UserMessage | AssistantMessage | ToolMessage;

type ChatResponse = {
    choices: {
        message: AssistantMessage;
        finish_reason: string;
    }[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
    };
}

const tools = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the contents of a file. Use this to look at files in the user's project.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Path to the file, relative to the current folder",
                    },
                },
                required: ["path"],
            },
        },
    },
];

async function runTool(toolCall: ToolCall): Promise<string> {
    const name = toolCall.function.name;

    let args: any;
    try {
        args = JSON.parse(toolCall.function.arguments);
    } catch {
        return `Error: the arguments were not valid JSON: ${toolCall.function.arguments}`;
    }

    if (name === "read_file") {
        try {
            return await readFile(args.path, "utf-8");
        } catch (error) {
            return `Error reading file: ${error}`;
        }
    }

    return `Error: unknown tool "${name}"`;
}

const messages: Message[] = [];

console.log('Chat started. Type "exit" to quit.\n');

while (true) {

    const input = prompt("You:");

    if (input === null || input.toLowerCase() === "exit") {
        console.log("Exiting chat...");
        break;
    }

    const turnStart = messages.length;
    messages.push({ role: "user", content: input });

    // The agent loop: keep calling the model until it stops asking for tools
    while (true) {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: model, messages: messages, tools: tools }),
        });

        if (!response.ok) {
            console.error(`Error: ${response.status}`, await response.text());
            messages.splice(turnStart); // Undo this whole turn
            break;
        }

        const data = (await response.json()) as ChatResponse;
        const choice = data.choices[0];

        if (!choice) {
            console.error("Error: No choices returned from the API.");
            messages.splice(turnStart); // Undo this whole turn
            break;
        }

        const message = choice.message;
        messages.push(message);

        if (message.content) {
            console.log("\nClaude:", message.content);
        }

        const tokensIn = data.usage?.prompt_tokens ?? 0;
        const tokensOut = data.usage?.completion_tokens ?? 0;
        console.log(`(Tokens: ${tokensIn} in, ${tokensOut} out)`);

        if (!message.tool_calls || message.tool_calls.length === 0) {
            break; // No tools requested, so the model is done
        }

        for (const toolCall of message.tool_calls) {
            console.log(`[tool] ${toolCall.function.name} ${toolCall.function.arguments}`);
            const result = await runTool(toolCall);
            messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
        }
    }

    console.log();
}

console.log("Chat ended.");