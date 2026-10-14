import { readFile, readdir} from "fs/promises";
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
    {
        type: "function",
        function: {
            name: "list_files",
            description: "List the files in a directory. Use this to see what files are available in the user's project.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Path to the directory, relative to the current folder",
                    },
                },
                required: [],
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
    else if (name === "list_files") {
        const folder = args.path ?? ".";

        try {
            const entries = await readdir(folder, { withFileTypes: true });

            const lines = entries.map((entry) => {
                if (entry.isDirectory()) {
                    return `${entry.name}/`;
                }
                return entry.name;
            });
            return lines.join("\n");
        }
        catch (error) {
            return `Error listing files: ${error}`;
        }
    }

    return `Error: unknown tool "${name}"`;
}