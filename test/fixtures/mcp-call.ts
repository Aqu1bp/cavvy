// The MCP client side of the fake CLIs: what Claude Code and Codex do with an
// HTTP MCP server they're given (initialize, tools/list, tools/call), over
// Streamable HTTP, taking the answer as JSON or from an SSE stream.

export interface McpServerRef {
    url: string;
    headers: Record<string, string>;
}

let seq = 0;

async function post(s: McpServerRef, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(s.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...s.headers },
        body: JSON.stringify(body),
    });
    if (body.id === undefined) {
        await res.body?.cancel();
        return undefined;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for (const ev of text.split("\n\n")) {
            const data = ev
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("\n");
            if (!data) continue;
            const msg = JSON.parse(data);
            if (msg.id === body.id) return msg;
        }
        throw new Error("stream ended without the response");
    }
    return JSON.parse(text);
}

export async function rpc(s: McpServerRef, method: string, params: Record<string, unknown> = {}): Promise<any> {
    const msg = await post(s, { jsonrpc: "2.0", id: ++seq, method, params });
    if (msg.error) throw new Error(msg.error.message);
    return msg.result;
}

/** Connect as a client does: initialize, then the initialized notification. */
export async function connect(s: McpServerRef): Promise<{ instructions?: string; tools: any[] }> {
    const init = await rpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
    await post(s, { jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await rpc(s, "tools/list");
    return { instructions: init.instructions, tools: list.tools };
}

export async function callTool(s: McpServerRef, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await rpc(s, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    return { text: (r.content ?? []).map((c: any) => c.text ?? "").join("\n"), isError: Boolean(r.isError) };
}
