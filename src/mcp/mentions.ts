// "@server:uri" in a prompt: the MCP resource attached, as "@path" attaches a
// file (src/ui/mentions.ts). The server part is a configured server's name;
// the rest, up to the next space, is the URI (one of its resources, or a
// template filled in).

import type { UserContent } from "../providers/types";
import type { McpAsker } from "./elicitation";
import type { McpManager } from "./manager";

/** Resources one prompt attaches at most; more are left as text. */
const MAX_MENTIONS = 10;

export interface McpMention {
    server: string;
    uri: string;
    raw: string;
}

/** The "@server:uri" mentions in `text` whose server is one of `servers` (longest name first, so "a:b" beats "a"). */
export function findMcpMentions(text: string, servers: string[]): McpMention[] {
    if (!servers.length || !text.includes("@")) return [];
    const names = [...servers].sort((a, b) => b.length - a.length);
    const out: McpMention[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(/(^|\s)@(\S+)/g)) {
        // Closing punctuation of the sentence isn't part of the URI.
        const raw = m[2]!.replace(/[.,;:!?]+$/, "");
        const server = names.find((n) => raw.startsWith(`${n}:`) && raw.length > n.length + 1);
        if (!server) continue;
        const uri = raw.slice(server.length + 1);
        const key = `${server}\0${uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ server, uri, raw });
    }
    return out;
}

/**
 * Read the resources a prompt mentions and append them to its parts: text
 * as a block per resource, images as image parts. A resource that can't be
 * read is left out with a notice, and the prompt still goes.
 */
export async function expandMcpMentions(text: string, mcp: McpManager | undefined, asker: McpAsker, signal?: AbortSignal): Promise<{ parts: UserContent[]; attached: string[]; notices: string[] }> {
    const out = { parts: [] as UserContent[], attached: [] as string[], notices: [] as string[] };
    if (!mcp) return out;
    // Every configured server's name: one that isn't connected (or needs signing in) gets a notice, not silence.
    const mentions = findMcpMentions(text, [...mcp.servers.keys()]);
    // A name no server has, before what is plainly a URI ("@gh:repo://x"): most likely a server that isn't configured here.
    for (const m of text.matchAll(/(^|\s)@([\w.-]+):([a-z][\w+.-]*:\/\/\S*)/gi)) {
        if (!mcp.servers.has(m[2]!) && !mentions.some((x) => x.raw.startsWith(`${m[2]}:`))) out.notices.push(`Couldn't attach @${m[2]}:${m[3]!.replace(/[.,;:!?]+$/, "")}: there's no MCP server named "${m[2]}".`);
    }
    if (mentions.length > MAX_MENTIONS) out.notices.push(`Only the first ${MAX_MENTIONS} MCP resources were attached.`);
    for (const m of mentions.slice(0, MAX_MENTIONS)) {
        if (signal?.aborted) break;
        try {
            const r = await mcp.readResource(m.server, m.uri, asker, signal);
            out.parts.push({ type: "text", text: `Contents of MCP resource ${m.server}:${r.uri} (attached by the user with @${m.raw}):\n${r.text || "(empty)"}` });
            for (const im of r.images) out.parts.push(im);
            out.attached.push(`${m.server}:${r.uri}`);
        } catch (e) {
            out.notices.push(`Couldn't attach @${m.raw}: ${(e as Error).message}`);
        }
    }
    return out;
}

/**
 * Resources matching what's typed after the @: by the whole "server:uri",
 * its name or title, a prefix match first. An empty query lists none (files
 * come first then).
 */
export function searchResources<T extends { mention: string; name: string; title?: string; uri: string }>(all: T[], query: string, limit: number): T[] {
    const q = query.toLowerCase();
    if (!q) return [];
    const score = (r: T): number => {
        const m = r.mention.toLowerCase();
        if (m.startsWith(q)) return 0;
        if (r.uri.toLowerCase().startsWith(q) || r.name.toLowerCase().startsWith(q) || r.title?.toLowerCase().startsWith(q)) return 1;
        if (m.includes(q) || r.name.toLowerCase().includes(q) || r.title?.toLowerCase().includes(q)) return 2;
        return -1;
    };
    return all
        .map((r) => [r, score(r)] as const)
        .filter(([, sc]) => sc >= 0)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .map(([r]) => r);
}
