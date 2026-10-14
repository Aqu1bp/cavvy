import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import type { ToolCall } from "./types";
import { dirname } from "path";

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
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to a file. Use this to create or modify files in the user's project. Creates new files if they don't exist, and overwrites existing files.",
            parameters: {
                type: "object",
                properties: { path: { type: "string", description: "Path to the file, relative to the current folder" }, content: { type: "string", description: "Content to write to the file" } },
                required: ["path", "content"],
            },
        },
    },
];

const toolsNeedingPermission = ["write_file", "edit_file", "run_bash"];

export function needsPermission(name: string): boolean {
    return toolsNeedingPermission.includes(name);
}

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
    else if (name === "write_file") {
        try {
            await mkdir(dirname(args.path), { recursive: true });
            await writeFile(args.path, args.content, "utf-8");
            return `Wrote ${args.content.length} characters to ${args.path}`;
        }
        catch (error) {
            return `Error writing file: ${error}`;
        }
    }

    return `Error: unknown tool "${name}"`;
}