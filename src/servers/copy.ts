// The one-time copy offered when a server is added: this machine's settings,
// memory, skills and commands, so Cavvy there starts out working the way it
// does here.
//
// Never copied:
//   - keys and sign-ins: nothing from the credential stores, no settings that
//     can hold one (`env`, an MCP server's `env` or `headers`), and no file
//     that reads like it has one in it;
//   - hooks and the status line: they're commands, and would run on the server;
//   - the permission mode: a server decides its own;
//   - MCP servers that run a program or name a file on this machine.
//
// Nothing already on the server is replaced: a file that's there is kept.

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, relative, sep } from "path";
import { cavvyHome, paths } from "../config/paths";
import type { McpServerConfig, Settings } from "../config/settings";
import { childEnv } from "../util/env";
import { matchesSecretPattern } from "../util/secret-patterns";
import { hostOf, remoteSh, ssh } from "./ssh";
import { ServerError, type ServerEntry } from "./store";

/** Settings that are a way of working, and can't hold a secret or run a command. */
const SETTINGS_KEYS = [
    "model",
    "smallModel",
    "reviewModel",
    "effort",
    "fastMode",
    "autoCompact",
    "autoCompactThreshold",
    "idleCompaction",
    "idleCompactionMinTokens",
    "showThinking",
    "maxOutputTokens",
    "webSearch",
    "bashTimeout",
    "pacedOutput",
    "claudeCode",
    "agentCli",
    "codex",
    "notifications",
    "notifyAfterSeconds",
    "followUpBehavior",
    "autoResume",
    "delegation",
    "worktree",
] as const satisfies readonly (keyof Settings)[];

const looksLocal = (s: string) => /^(~|\.{1,2}(\/|$)|\/)/.test(s) || s.includes(homedir());

/** An MCP server that would work from another machine as it's written, and holds nothing secret. */
export function portableMcpServer(c: McpServerConfig): boolean {
    if (c.plugin || c.env || c.headers || c.cwd || c.oauth?.clientSecret) return false;
    if (c.url) return !c.command && /^(https?|wss?):\/\//.test(c.url) && !/\/\/(localhost|127\.|\[::1\])/.test(c.url);
    if (!c.command || /[/\\]/.test(c.command) || looksLocal(c.command)) return false;
    return !(c.args ?? []).some(looksLocal);
}

/** The settings a server gets: what's safe to carry, and nothing else. */
export function portableSettings(s: Settings): Settings {
    const out: Record<string, unknown> = {};
    for (const k of SETTINGS_KEYS) if (s[k] !== undefined) out[k] = s[k];
    const p = s.permissions;
    if (p) {
        // The rules, not the mode: what a server asks about is its own decision.
        const rules = Object.fromEntries((["allow", "ask", "deny"] as const).filter((k) => Array.isArray(p[k]) && p[k]!.length).map((k) => [k, p[k]]));
        if (Object.keys(rules).length) out.permissions = rules;
    }
    const servers = Object.entries(s.mcpServers ?? {}).filter(([, c]) => c && typeof c === "object" && portableMcpServer(c));
    if (servers.length) out.mcpServers = Object.fromEntries(servers);
    return out as Settings;
}

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_FILES = 3000;
/** Names that are keys, whatever is in them. */
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.?credentials(\..*)?|\.netrc|\.npmrc|auth\.json)$/i;
const SKIP_DIR = new Set([".git", "node_modules", ".venv", "__pycache__", ".DS_Store"]);

export interface CopyPlan {
    /** A folder laid out as the server's home is. */
    stage: string;
    /** What goes, by kind. */
    counts: { settings: boolean; memory: number; skills: number; commands: number };
    files: number;
    cleanup(): void;
}

class Stage {
    files = 0;
    bytes = 0;
    constructor(readonly dir: string) {}

    /** Puts `from` at `to` (relative to the server's home), unless it's too big, a key, or reads like it holds one. */
    file(from: string, to: string): boolean {
        if (this.files >= MAX_FILES || /[\0-\x1f]/.test(to)) return false;
        let size: number;
        try {
            const st = statSync(from);
            if (!st.isFile()) return false;
            size = st.size;
        } catch {
            return false;
        }
        const name = to.split("/").at(-1)!;
        if (size > MAX_FILE || this.bytes + size > MAX_TOTAL || SECRET_NAME.test(name)) return false;
        let body: Buffer;
        try {
            body = readFileSync(from);
        } catch {
            return false;
        }
        // Text that carries a key (a token pasted into a memory file) stays here.
        if (!body.includes(0) && matchesSecretPattern(body.toString("utf-8"))) return false;
        const dest = join(this.dir, to);
        mkdirSync(join(dest, ".."), { recursive: true });
        cpSync(from, dest);
        this.files++;
        this.bytes += size;
        return true;
    }

    /** A folder's files, at most `depth` deep. A link is followed once, at the top: a skill kept elsewhere. */
    tree(from: string, to: string, depth = 6, top = true): number {
        let n = 0;
        let names: string[];
        try {
            names = readdirSync(from);
        } catch {
            return 0;
        }
        for (const name of names.sort()) {
            if (SKIP_DIR.has(name)) continue;
            const path = join(from, name);
            let dir: boolean;
            try {
                const l = lstatSync(path);
                if (l.isSymbolicLink() && !top) continue;
                dir = statSync(path).isDirectory();
            } catch {
                continue;
            }
            if (dir) {
                if (depth > 0) n += this.tree(path, `${to}/${name}`, depth - 1, false);
            } else if (this.file(path, `${to}/${name}`)) n++;
        }
        return n;
    }
}

/** What would be copied from this machine, staged. `settings`: this machine's own settings file, read. */
export function planCopy(settings: Settings | undefined): CopyPlan {
    const dir = mkdtempSync(join(tmpdir(), "cavvy-copy-"));
    const stage = new Stage(dir);
    const claude = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const codex = process.env.CODEX_HOME || join(homedir(), ".codex");
    const counts = { settings: false, memory: 0, skills: 0, commands: 0 };

    const portable = settings ? portableSettings(settings) : {};
    if (Object.keys(portable).length) {
        mkdirSync(join(dir, ".cavvy"), { recursive: true });
        writeFileSync(join(dir, ".cavvy", "settings.json"), JSON.stringify(portable, null, 2) + "\n");
        stage.files++;
        counts.settings = true;
    }
    const memory = paths.userMemory();
    if (stage.file(memory, `.cavvy/${relative(cavvyHome(), memory).split(sep).join("/")}`)) counts.memory++;
    if (stage.file(join(claude, "CLAUDE.md"), ".claude/CLAUDE.md")) counts.memory++;
    counts.memory += stage.tree(join(claude, "rules"), ".claude/rules");
    if (stage.file(join(codex, "AGENTS.md"), ".codex/AGENTS.md")) counts.memory++;

    const skillsIn = (root: string) => {
        try {
            return readdirSync(root).filter((n) => existsSync(join(root, n, "SKILL.md"))).length;
        } catch {
            return 0;
        }
    };
    stage.tree(join(cavvyHome(), "skills"), ".cavvy/skills");
    stage.tree(join(claude, "skills"), ".claude/skills");
    counts.skills = skillsIn(join(dir, ".cavvy", "skills")) + skillsIn(join(dir, ".claude", "skills"));
    counts.commands = stage.tree(paths.userCommands(), ".cavvy/commands");
    return { stage: dir, counts, files: stage.files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** "settings, memory, 12 skills and 3 commands": what a plan carries, for the line that says so. */
export function describeCopy(c: CopyPlan["counts"]): string {
    const parts = [...(c.settings ? ["settings"] : []), ...(c.memory ? ["memory"] : []), ...(c.skills ? [`${c.skills} skill${c.skills === 1 ? "" : "s"}`] : []), ...(c.commands ? [`${c.commands} command${c.commands === 1 ? "" : "s"}`] : [])];
    if (parts.length <= 1) return parts[0] ?? "";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Unpacks stdin beside the server's home and moves in each file that isn't there yet. */
const RECEIVE = `
set -e
umask 077
t=$(mktemp -d "\${TMPDIR:-/tmp}/cavvy-copy.XXXXXX")
trap 'rm -rf "$t"' EXIT
tar -xzf - -C "$t"
cd "$t"
find . -type f | while IFS= read -r f; do
    dest="$HOME/\${f#./}"
    [ -e "$dest" ] && continue
    mkdir -p "$(dirname "$dest")"
    mv "$f" "$dest"
    echo "copied=\${f#./}"
done
`;

/** Sends a plan's files. Returns how many the server took (the rest were there already). */
export async function sendCopy(e: ServerEntry, plan: CopyPlan, signal?: AbortSignal): Promise<number> {
    if (!plan.files) return 0;
    const tar = Bun.spawn(["tar", "-czf", "-", "-C", plan.stage, "."], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...childEnv(), COPYFILE_DISABLE: "1" } });
    const body = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
    if ((await tar.exited) !== 0) throw new ServerError("Couldn't pack your settings to copy.");
    const r = await ssh(e, remoteSh(RECEIVE), { stdin: body, timeoutMs: 120_000, signal });
    if (r.code !== 0) throw new ServerError(`Couldn't copy your settings to ${hostOf(e)}: ${r.stderr.trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
    return r.stdout.split("\n").filter((l) => l.startsWith("copied=")).length;
}
