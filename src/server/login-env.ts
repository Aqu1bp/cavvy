// Apps started from the Dock, Finder or a desktop launcher don't get the PATH
// your shell sets up (Homebrew, nvm, cargo, …), so commands the agent runs
// wouldn't find your tools. The desktop app's server asks your login shell
// for its PATH once at startup and adds what's missing.

const MARK = "__CAVVY_PATH__";

/** PATH as your interactive login shell sets it, or undefined if that couldn't be found out. */
export async function loginShellPath(timeoutMs = 4000): Promise<string | undefined> {
    if (process.platform === "win32") return undefined;
    const shell = process.env.SHELL && /^\/[\w./-]+$/.test(process.env.SHELL) ? process.env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    try {
        const proc = Bun.spawn([shell, "-ilc", `printf '\\n${MARK}%s${MARK}\\n' "$PATH"`], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
            env: { ...process.env, TERM: "dumb", CAVVY_LOGIN_ENV: "1" } as Record<string, string>,
        });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const out = await new Response(proc.stdout).text();
        clearTimeout(timer);
        const m = out.match(new RegExp(`${MARK}(.*?)${MARK}`));
        return m?.[1] || undefined;
    } catch {
        return undefined;
    }
}

/** The login shell's PATH entries first, then any of ours it doesn't have. */
export function mergePath(current: string | undefined, login: string | undefined): string | undefined {
    if (!login) return current;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [...login.split(":"), ...(current ?? "").split(":")]) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        out.push(p);
    }
    return out.join(":");
}

let answer: Promise<unknown> = Promise.resolve();
/**
 * When the login shell has answered (adoptLoginPath). What's looked for on PATH once and then kept (the providers' CLIs, local MCP
 * servers: one that isn't found stays failed) looks after this, so a tool that's new since last time is found.
 */
export const loginPathSettled = () => answer;

/**
 * Takes PATH from your login shell. One that takes seconds to start (nvm, oh-my-zsh) shouldn't hold up the app: what it said
 * last time, remembered in `file`, is used at once and its answer takes over when it comes. Only a first launch waits.
 * Bun.which doesn't see this (it reads the PATH the process started with): pass it `{ PATH: process.env.PATH }`.
 */
export async function adoptLoginPath(file: string) {
    const started = process.env.PATH;
    const remembered = await Bun.file(file).text().catch(() => undefined);
    const answered = loginShellPath().then(async (login) => {
        if (!login) return;
        process.env.PATH = mergePath(started, login);
        if (login !== remembered) await Bun.write(file, login).catch(() => undefined);
    });
    answer = answered;
    if (remembered) process.env.PATH = mergePath(started, remembered);
    else await answered;
    return { answered };
}
