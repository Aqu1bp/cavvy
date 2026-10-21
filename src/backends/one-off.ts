/**
 * One-off requests on Claude Code and Codex: a question with no tools (a
 * prompt hook, MCP sampling, a title or a summary) that the CLI answers
 * with its own model and sign-in, in a throwaway session of its own.
 */
import type { AssistantMessage, ChatRequest } from "../providers/types";
import { ProviderError } from "../providers/types";

/** How long a one-off may take when the request gives no signal of its own. */
export const ONE_OFF_TIMEOUT_MS = 120_000;

/** A request the CLI can answer as a one-off: it offers no tools. */
export function oneOffRefusal(name: string, req: ChatRequest): ProviderError | undefined {
    return req.tools?.length ? new ProviderError(`${name} runs whole turns with its own tools, so it can't answer a request that offers tools of the harness's. Set smallModel to another provider's model for those.`) : undefined;
}

/** The conversation as one prompt: the CLIs take a single message. Earlier turns are labelled by who said them. */
export function oneOffPrompt(req: ChatRequest): string {
    const text = (m: ChatRequest["messages"][number]) =>
        (Array.isArray(m.content) ? m.content : [])
            .flatMap((p: any) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : []))
            .join("\n");
    if (req.messages.length === 1) return text(req.messages[0]!);
    return req.messages.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${text(m)}`).join("\n\n");
}

export function oneOffAnswer(provider: string, model: string, text: string, usage?: AssistantMessage["usage"]): AssistantMessage {
    return { role: "assistant", provider, model, stopReason: "end_turn", content: text ? [{ type: "text", text }] : [], ...(usage ? { usage } : {}) };
}
