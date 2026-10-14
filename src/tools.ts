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
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "Edit the contents of a file. Use this to modify files in the user's project. The old_text must match the text in the file including spaces and indentation, and will be replaced with new_text. Prefer this over write_file when you want to make changes to an existing file.",
            parameters: {
                type: "object",
                properties: { path: { type: "string", description: "Path to the file, relative to the current folder" }, old_text: { type: "string", description: "The text to be replaced in the file." }, new_text: { type: "string", description: "The new text to replace the old text with" } },
                required: ["path", "old_text", "new_text"],
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
        else if (name === "edit_file") {
        try {
            const content = await readFile(args.path, "utf-8");
            const parts = content.split(args.old_text);
            const count = parts.length - 1;

            if (count === 0) {
                return `Error: old_text was not found in ${args.path}. Read the file again and check the text.`;   // error: not found
            }
            if (count > 1) {
                return `Error: old_text appears ${count} times in ${args.path}. Include more surrounding lines in old_text so it matches only once.`;   // error: found too many times
            }

            await writeFile(args.path, parts.join(args.new_text), "utf-8");
            return `Edited ${args.path}`;
        } catch (error) {
            return `Error editing file: ${error}`;
        }
    }

    return `Error: unknown tool "${name}"`;
}