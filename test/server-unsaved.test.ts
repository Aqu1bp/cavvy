// The desktop app asks before quitting only when a session's latest work couldn't be saved (server.unsaved).
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { Message } from "../src/providers/types";
import type { EngineClient } from "../src/server/engine";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Session } = await import("../src/agent/session");
afterAll(iso.cleanup);

const prompt = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" } });

test("server.unsaved lists the sessions whose latest work a full disk kept from being saved, and no others", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const made = Session.create(realpathSync(tempDir("unsaved-")));
        made.push(prompt("first"));
        made.setTitle("Saved so far");
        made.release();
        const rt = engine.openSession(made.meta.id);
        await rt.ready;
        const client: EngineClient = { subs: new Set(), send: () => {} };
        expect(await engine.handle(client, "server.unsaved", {})).toEqual({ sessions: [], working: 0 });
        const real = fs.appendFileSync;
        const spy = spyOn(fs, "appendFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | Uint8Array, opts?: fs.WriteFileOptions) => {
            if (String(file) === rt.session.path) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
            return real(file, data, opts);
        }) as typeof fs.appendFileSync);
        try {
            rt.session.push(prompt("while full"));
            expect(await engine.handle(client, "server.unsaved", {})).toEqual({ sessions: [{ id: rt.id, title: "Saved so far" }], working: 0 });
        } finally {
            spy.mockRestore();
        }
        // Room again: saved with the next write, and nothing's left to lose.
        rt.session.push(prompt("after"));
        expect(await engine.handle(client, "server.unsaved", {})).toEqual({ sessions: [], working: 0 });
    } finally {
        await engine.stop();
    }
});

test("server.unsaved counts this computer's sessions that are working, for the desktop app's quit question", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const made = Session.create(realpathSync(tempDir("working-")));
        made.push(prompt("first"));
        made.release();
        const rt = engine.openSession(made.meta.id);
        await rt.ready;
        const client: EngineClient = { subs: new Set(), send: () => {} };
        expect((await engine.handle(client, "server.unsaved", {})).working).toBe(0);
        rt.busy = true;
        try {
            expect((await engine.handle(client, "server.unsaved", {})).working).toBe(1);
            // An update restarting the app asked before it began: quitting for it doesn't ask again.
            (engine as unknown as { updates: { patch(p: object): void } }).updates.patch({ updating: { startedAt: 0, line: "", restarting: true } });
            expect((await engine.handle(client, "server.unsaved", {})).working).toBe(0);
        } finally {
            rt.busy = false;
        }
        expect((await engine.handle(client, "server.unsaved", {})).working).toBe(0);
    } finally {
        await engine.stop();
    }
});
