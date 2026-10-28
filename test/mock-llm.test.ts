// The mock model the demo and tests talk to (scripts/mock-llm.ts), sent conversations as Cavvy sends them over Chat
// Completions: which user message is the prompt when a tool's images ride in one (they can't go in a tool result), and
// the browser script showing its screenshot in its reply, whatever the screenshot's path holds.
import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { toOpenAIMessages } = await import("../src/providers/openai-compat");
const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
const { imageMarkdown } = await import("../src/tools/browser-tools");
type Message = import("../src/providers/types").Message;

const mock = startMockLlm({ delayMs: 0 });
afterAll(() => {
    mock.stop();
    iso.cleanup();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const groq = BUILTIN_PROVIDERS.find((p) => p.id === "groq")!;

/** The mock's reply to a conversation (its text), and the prompt it took the turn to be for. */
async function reply(history: Message[]): Promise<{ text: string; prompt: string }> {
    const tools = ["BrowserNavigate", "BrowserAct", "BrowserScreenshot"].map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }));
    const res = await fetch(`${mock.url}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "mock-opus", stream: true, tools, messages: toOpenAIMessages("SYS", history, groq) }) });
    let text = "";
    for (const line of (await res.text()).split("\n")) if (line.startsWith("data: {")) text += JSON.parse(line.slice(6)).choices[0]?.delta?.content ?? "";
    return { text, prompt: mock.requests.at(-1)!.prompt };
}

/** The browser script up to its screenshot, saved at `file`; then whatever else the user's next message carries. */
function browserTurn(file: string, more: string[] = []): Message[] {
    const call = (id: string, name: string): Message => ({ role: "assistant", provider: "mock", model: "mock-opus", content: [{ type: "tool_call", id, name, input: {} }] });
    const result = (id: string, name: string, content: string): Message => ({ role: "user", content: [{ type: "tool_result", toolCallId: id, toolName: name, content }], meta: { kind: "tool_results" } });
    const shot = `Screenshot of the viewport of tab [1] (1280×800 CSS pixels) at http://localhost:3000/. Saved as ${file}: to show it to the user, put ${imageMarkdown(file)} in your last message.`;
    return [
        { role: "user", content: [{ type: "text", text: "check the page in the browser" }] },
        call("c1", "BrowserNavigate"),
        result("c1", "BrowserNavigate", 'button "Count" [e3]'),
        call("c2", "BrowserAct"),
        result("c2", "BrowserAct", "Clicked button"),
        call("c3", "BrowserScreenshot"),
        { role: "user", content: [{ type: "tool_result", toolCallId: "c3", toolName: "BrowserScreenshot", content: shot, images: [{ type: "image", mediaType: "image/png", data: PNG }] }, ...more.map((text) => ({ type: "text" as const, text }))], meta: { kind: "tool_results" } },
    ];
}

test("a tool's images, and Cavvy's notes with them, aren't a prompt: the turn goes on", async () => {
    for (const more of [[], ["<system-reminder>A note.</system-reminder>"]]) {
        const r = await reply(browserTurn("/tmp/shots/a.png", more));
        expect(r.prompt).toBe("check the page in the browser");
        expect(r.text).toBe("The page loads and the button works.\n\n![The page after the click](/tmp/shots/a.png)");
    }
});

test("what the user steered with, sent with a tool's images, is the prompt", async () => {
    const r = await reply(browserTurn("/tmp/shots/a.png", ["Stop there. What's 2+2?"]));
    expect(r.prompt).toBe("Stop there. What's 2+2?");
    expect(r.text).not.toContain("The page loads");
});

test("the browser script shows its screenshot whatever the path holds", async () => {
    for (const file of ["/tmp/Cavvy Demo/screenshots/a b.png", "/tmp/cavvy)/a.png", "/tmp/100%/a.png"]) {
        const r = await reply(browserTurn(file));
        expect(r.text).toBe(`The page loads and the button works.\n\n${imageMarkdown(file).replace("what it shows", "The page after the click")}`);
    }
});
