import { readFile } from "fs/promises";
import type { ToolCall } from "./types";

export const tools = [
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

export async function runTool(toolCall: ToolCall): Promise<string> {
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