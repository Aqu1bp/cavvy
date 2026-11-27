import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionSummary } from "../src/server/protocol";
import type { Message } from "../src/providers/types";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { Engine } = await import("../src/server/engine");
const { getProvider } = await import("../src/providers/registry");
const { conversationGist, modelTitle } = await import("../src/server/runtime");
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
afterAll(() => {
    mock.stop();
    iso.cleanup();
});

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const said = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] }) as Message;

describe("what a title is made from", () => {
    test("the first request, then the latest said, text only, newest last", () => {
        const gist = conversationGist([
            user("Fix the login redirect"),
            said("Done."),
            { role: "user", content: [{ type: "tool_result", id: "t", content: "lots of output" }] } as unknown as Message,
            user("<system-reminder>ignore</system-reminder>Now add SSO"),
        ]);
        expect(gist).toBe("First request:\nUser: Fix the login redirect\n\nLatest:\nAssistant: Done.\nUser: Now add SSO");
        expect(conversationGist([])).toBe("");
    });

    test("a long conversation keeps within its size, the latest kept", () => {
        const many = Array.from({ length: 200 }, (_, i) => user(`Request ${i} ${"word ".repeat(40)}`));
        const gist = conversationGist(many, 2000);
        expect(gist.length).toBeLessThan(2100);
        expect(gist).toContain("Request 0 ");
        expect(gist).toContain("Request 199 ");
        expect(gist).not.toContain("Request 100 ");
    });

    test("a model's answer as a title", () => {
        expect(modelTitle('Title: "Add SSO sign-in".')).toBe("Add SSO sign-in");
        expect(modelTitle("\n\n<b>Fix login</b>\nmore")).toBe("Fix login");
        expect(modelTitle("This is a whole paragraph that goes on and on about the session and more")).toBeUndefined();
        expect(modelTitle(undefined)).toBeUndefined();
    });
});

describe("Regenerate title", () => {
    const listModels = async () => [{ provider: getProvider("mock")!, status: "ok" as const, models: [{ provider: "mock", id: "mock-opus" }, { provider: "mock", id: "mock-haiku" }] }];
    const setup = () => {
        const engine = new Engine({ listModels, unloadAfterMs: 50 });
        const rows: SessionSummary[] = [];
        const client = { subs: new Set<string>(), send: (e: { type: string; session?: SessionSummary }) => e.type === "sessions.upsert" && rows.push(e.session!) };
        engine.clients.add(client as never);
        const call = (method: string, params: unknown) => engine.handle(client as never, method as never, params) as Promise<any>;
        const until = async (what: string, ok: () => boolean) => {
            for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(10);
            if (!ok()) throw new Error(`timed out waiting for ${what}`);
        };
        const turn = async (id: string, text: string) => {
            const rt = engine.runtimes.get(id)!;
            const before = rt.session.messageCount;
            await call("session.send", { id, text });
            await until("the turn to end", () => !rt.busy && rt.session.messageCount > before);
        };
        return { engine, rows, call, until, turn };
    };

    test("names it from what it's about now; the row hears it", async () => {
        const { engine, call, turn, until, rows } = setup();
        try {
            const id = (await call("session.create", { cwd: realpathSync(tempDir()) })).state.id as string;
            await turn(id, "Explain the billing module");
            await until("its first title", () => engine.runtimes.get(id)!.title === "Explain the billing module");
            await turn(id, "refactor the session list please");
            expect(await call("session.regenerateTitle", { id })).toEqual({ title: "Refactor the session list" });
            expect(engine.runtimes.get(id)!.title).toBe("Refactor the session list");
            expect(rows.findLast((r) => r.id === id)?.title).toBe("Refactor the session list");
        } finally {
            await engine.stop();
        }
    });

    test("a model that fails leaves the old title, and says so", async () => {
        const { engine, call, turn, until } = setup();
        try {
            const id = (await call("session.create", { cwd: realpathSync(tempDir()) })).state.id as string;
            await turn(id, "Explain the billing module");
            await until("its first title", () => engine.runtimes.get(id)!.title === "Explain the billing module");
            await turn(id, "keep it untitled for now");
            await expect(call("session.regenerateTitle", { id })).rejects.toThrow("Couldn't make a title.");
            expect(engine.runtimes.get(id)!.title).toBe("Explain the billing module");
        } finally {
            await engine.stop();
        }
    });

    test("one that isn't open is opened for it, and closed again after", async () => {
        const { engine, call, turn, until } = setup();
        try {
            const cwd = realpathSync(tempDir());
            const id = (await call("session.create", { cwd })).state.id as string;
            await turn(id, "Explain the billing module");
            await call("session.close", { id });
            await until("it to close", () => !engine.runtimes.has(id));
            expect(await call("session.regenerateTitle", { id })).toEqual({ title: "Explain the billing module" });
            await until("it to close again", () => !engine.runtimes.has(id));
            expect(engine.listSessions().find((s) => s.id === id)?.title).toBe("Explain the billing module");
        } finally {
            await engine.stop();
        }
    });
});
