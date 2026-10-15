// `harness gui` and `harness serve`.
//
//   harness gui                      start the server and open the GUI in your browser
//   harness serve [--port n]         just the server (prints a link to open)
//   harness serve --handshake        for the desktop app: prints one JSON line with the
//                                    port and token on stdout, and exits when stdin closes

import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { APP_NAME, APP_VERSION } from "../config/paths";
import { childEnv } from "../util/env";
import { redact } from "../util/redact";
import { startServer } from "./server";
import { onConfigWarning } from "../config/settings";
import { adoptLoginPath } from "./login-env";

export interface ServeCliEnv {
    fallbackModel?: string;
    notes: string[];
}

function die(msg: string): never {
    process.stderr.write(`${APP_NAME}: ${msg}\n`);
    process.exit(1);
}

export const SERVE_HELP = `Usage:
  ${APP_NAME} gui [options]       start the GUI server and open it in your browser
  ${APP_NAME} serve [options]     start the GUI server only

Options:
  --port <n>                      port to listen on (default: a free one)
  --host <addr>                   address to listen on (default 127.0.0.1; anything else exposes
                                  a server that runs commands as you, so only behind your own auth)
  --no-open / --open              don't / do open a browser
  --handshake                     print {"port","token"} as one JSON line and exit when stdin closes
  --login-env                     take PATH from your login shell (for apps started outside a terminal)
  --dangerously-skip-permissions  allow bypass mode in the GUI
  --dev-origin <url>              also accept connections from this origin (a Vite dev server)`;

function defaultStatic(): string | undefined {
    const candidates = [process.env.HARNESS_GUI_DIST, join(resolve(import.meta.dir, "..", ".."), "gui", "dist"), join(dirname(process.execPath), "gui")].filter((d): d is string => Boolean(d));
    return candidates.find((d) => existsSync(join(d, "index.html")));
}

function openBrowser(url: string) {
    const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
    try {
        Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: childEnv() });
    } catch {
        process.stderr.write(`Couldn't open a browser. Open this link: ${url}\n`);
    }
}

export async function serveCommand(sub: "gui" | "serve", args: string[], env: ServeCliEnv): Promise<void> {
    let port: number | undefined;
    let host: string | undefined;
    let open = sub === "gui";
    let handshake = false;
    let loginEnv = false;
    let allowBypass = false;
    let token = process.env.HARNESS_GUI_TOKEN || undefined;
    const origins: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        const value = () => args[++i] ?? die(`${a} needs a value`);
        if (a === "--port") {
            port = Number(value());
            if (!Number.isInteger(port) || port < 0 || port > 65535) die("--port must be a port number");
        } else if (a === "--host") host = value();
        else if (a === "--open") open = true;
        else if (a === "--no-open") open = false;
        else if (a === "--handshake") {
            handshake = true;
            open = false;
        } else if (a === "--login-env") loginEnv = true;
        else if (a === "--dangerously-skip-permissions") allowBypass = true;
        else if (a === "--dev-origin") origins.push(value());
        else if (a === "-h" || a === "--help") {
            process.stdout.write(SERVE_HELP + "\n");
            process.exit(0);
        } else die(`unknown option ${a} (see ${APP_NAME} ${sub} --help)`);
    }
    if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) process.stderr.write(`warning: listening on ${host}: anyone who can reach it and has the token can run commands as you.\n`);

    const log = (msg: string) => process.stderr.write(`[${APP_NAME} ${sub}] ${redact(msg)}\n`);
    if (loginEnv) await adoptLoginPath();
    const srv = await startServer({ host, port, token, origins, allowBypass, staticDir: defaultStatic(), startCwd: process.cwd(), fallbackModel: env.fallbackModel, log });
    for (const n of env.notes) log(`note: ${n}`);
    // Broken settings files show up in the GUI, not just on a terminal nobody may be watching.
    onConfigWarning((message) => {
        log(`warning: ${message}`);
        srv.engine.broadcast({ type: "toast", level: "warn", message: redact(message) });
    });

    let stopping = false;
    const shutdown = async (code = 0) => {
        if (stopping) return;
        stopping = true;
        const timer = setTimeout(() => process.exit(code), 8000);
        await srv.stop().catch(() => undefined);
        clearTimeout(timer);
        process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
    process.on("SIGHUP", () => void shutdown(0));
    process.on("unhandledRejection", (e) => log(`internal error: ${(e as Error)?.stack ?? String(e)}`));

    if (handshake) {
        process.stdout.write(JSON.stringify({ type: "ready", port: srv.port, token: srv.token, version: APP_VERSION }) + "\n");
        // The desktop app holds our stdin; when it goes away, so do we.
        void (async () => {
            const reader = Bun.stdin.stream().getReader();
            try {
                while (!(await reader.read()).done) {
                    // nothing is sent; just wait for the end
                }
            } catch {
                // closed
            }
            await shutdown(0);
        })();
        return;
    }
    const link = srv.loginUrl();
    process.stderr.write(`\n  ${APP_NAME} GUI is running at ${srv.url}\n  Open (one-time link): ${link}\n  Press Ctrl+C to stop.\n\n`);
    if (open) openBrowser(link);
}
