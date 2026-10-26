// The stand-in for Chrome in test/helpers/fake-chrome-main.ts, as a program to name in HARNESS_BROWSER, and a way to see and
// steer it from the test.
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./isolate";

export interface FakeCommand {
    method: string;
    params: any;
    sessionId?: string;
}

/** A program that runs the fake Chrome (`bun fake-chrome-main.ts`), as an installed browser would be named. */
export function fakeChromeProgram(): string {
    const program = join(tempDir("harness-fake-chrome-"), "fake-chrome");
    writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-chrome-main.ts")}" "$@"\n`);
    chmodSync(program, 0o755);
    return program;
}

/** The fake running with this profile folder: what it was sent, and events for it to emit. */
export async function fakeChromeAt(profile: string) {
    const [port] = (await Bun.file(`${profile}/DevToolsActivePort`).text()).split("\n");
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
    return {
        log: (): Promise<FakeCommand[]> => fetch(`${base}/fake/log`).then((r) => r.json() as Promise<FakeCommand[]>),
        /** The commands of this name it was sent. */
        async sent(method: string): Promise<FakeCommand[]> {
            return (await this.log()).filter((c) => c.method === method);
        },
        emit: (method: string, params: unknown, sessionId?: string) => post("/fake/event", { method, params, sessionId }),
        /** A tab `opener` opened (as window.open does); its target id. */
        popup: async (opener: string): Promise<string> => (await post("/fake/popup", { opener })).targetId,
        /** Leaves every `method` command unanswered until release(method). */
        hold: (method: string) => post("/fake/hold", { method }),
        release: (method: string) => post("/fake/release", { method }),
    };
}
