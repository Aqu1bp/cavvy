// A folder opened without asking (it had nothing to protect) is still asked about once on Home: edits are
// checked for errors only in a folder the user trusted (src/lsp/manager.ts), so trusting it turns that on.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { trustedByUser } = await import("../src/config/trust");
afterAll(() => iso.cleanup());

test("a folder with nothing to protect is asked about until it's trusted or put off; one with settings is asked about by them", async () => {
    const engine = new Engine({});
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client);
    const inspect = (path: string) => engine.handle(client, "projects.inspect", { path });
    try {
        const plain = realpathSync(mkdtempSync(join(iso.home, "plain-")));
        // Opened without a question: trusted for the run, which doesn't turn on checking edits.
        expect(await inspect(plain)).toMatchObject({ trusted: true, needsTrust: [], askTrust: true });
        await engine.handle(client, "projects.trust", { path: plain, trust: true });
        expect(trustedByUser(plain)).toBe(true);
        expect((await inspect(plain)).askTrust).toBe(false);

        // "Not now": not asked again this run, and still not trusted.
        const later = realpathSync(mkdtempSync(join(iso.home, "later-")));
        await engine.handle(client, "projects.trust", { path: later, trust: false });
        expect((await inspect(later)).askTrust).toBe(false);
        expect(trustedByUser(later)).toBe(false);

        // Settings that can run commands: asked about by name, as before, not by this question too.
        const configured = realpathSync(mkdtempSync(join(iso.home, "configured-")));
        writeFileSync(join(configured, ".mcp.json"), JSON.stringify({ mcpServers: { x: { command: "true" } } }));
        expect(await inspect(configured)).toMatchObject({ needsTrust: [".mcp.json"], askTrust: false });

        // Not a folder: nothing to ask.
        const gone = join(iso.home, "gone");
        mkdirSync(join(iso.home, "elsewhere"), { recursive: true });
        expect((await inspect(gone)).askTrust).toBe(false);
    } finally {
        await engine.stop();
    }
});
