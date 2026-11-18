// The demo server (scripts/gui-demo.ts) for a check that drives it: on a port it picks itself, read from what it
// prints, so no port is let go of and taken again in between (another server, even the demo's own model or site,
// can be given it meanwhile, and the page then talks to that). If it stops or never says it's running, the error
// has what it printed.
import { join, resolve } from "path";

const repo = resolve(import.meta.dir, "..");

export interface DemoServer { proc: ReturnType<typeof Bun.spawn>; port: number }

export async function startDemoServer(o: { dir: string; token: string; dist: string; timeoutMs?: number }): Promise<DemoServer> {
    const proc = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "scripts/gui-demo.ts"), "--dir", o.dir, "--port", "0", "--token", o.token], {
        cwd: repo, env: { ...process.env, CAVVY_GUI_DIST: o.dist } as Record<string, string>, stdout: "pipe", stderr: "pipe",
    });
    let out = "";
    let port: number | undefined;
    const running = /is running at http:\/\/127\.0\.0\.1:(\d+)/;
    const read = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
            // Only its start is kept: what it prints later isn't needed, and isn't held.
            if (port !== undefined) continue;
            out = (out + decoder.decode(chunk, { stream: true })).slice(-64 * 1024);
            const m = running.exec(out);
            if (m) port = Number(m[1]);
        }
    };
    void read(proc.stdout as ReadableStream<Uint8Array>);
    void read(proc.stderr as ReadableStream<Uint8Array>);
    const end = performance.now() + (o.timeoutMs ?? 60_000);
    for (;;) {
        if (port !== undefined && (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false))) return { proc, port };
        const tail = () => out.trim().split("\n").slice(-30).join("\n");
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`The demo server stopped (${proc.exitCode ?? proc.signalCode}) before it was up. It printed:\n${tail()}`);
        if (performance.now() > end) {
            proc.kill();
            throw new Error(`The demo server wasn't up after ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s${port === undefined ? "" : ` (it said port ${port})`}. It printed:\n${tail()}`);
        }
        await Bun.sleep(100);
    }
}
