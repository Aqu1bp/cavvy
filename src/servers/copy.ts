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
//   - permission rules and MCP servers, unless they're of a shape that can't
//     hold a key: a rule of plain words with no options in it; an MCP server
//     that's only a package to run (`npx -y @scope/server`) or a public
//     address with a plain path. A key can sit anywhere in the others, so
//     they aren't searched for one: they stay, and the user is told how many.
//
// Nothing already on the server is replaced: a file that's there is kept.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, relative, sep } from "path";
import { cavvyHome, paths } from "../config/paths";
import type { McpServerConfig, Settings } from "../config/settings";
import { childEnv } from "../util/env";
import { matchesSecretPattern } from "../util/secret-patterns";
import { hostOf, printable, remoteSh, ssh } from "./ssh";
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

/** A host only this machine, or its own network, can reach. */
function localHost(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    // An address written out in IPv6: loopback, the private and link-local ranges, and any IPv4 address in IPv6
    // clothes (`::ffff:…`), which could be a local one. (A name can start with these letters too, so only here.)
    if (h.includes(":")) return h === "::" || h === "::1" || /^f[cde]/.test(h) || h.startsWith("::ffff:");
    if (/\.(local|localhost|localdomain|internal|lan|home\.arpa)$/.test(h) || h === "localhost" || !h.includes(".")) return true;
    // Loopback, private, link-local, and the range private networks between machines use (100.64/10).
    return /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
}

/** Letters and digits mixed as a key or a token is: more than three digits among letters. A number or a date isn't. */
const tokenLike = (s: string) => /[A-Za-z]/.test(s) && (s.match(/\d/g)?.length ?? 0) > 3;

/**
 * A word that's plainly a name: letters first, then letters, a few digits, and
 * dots, dashes or underscores between. Not something made up of letters and
 * digits at random, which is what a key or a token in an address looks like.
 */
function plainWord(s: string): boolean {
    return s.length <= 40 && /^[A-Za-z][A-Za-z0-9]*([._-][A-Za-z0-9]+)*$/.test(s) && !tokenLike(s);
}

/** A package as a runner takes it: `name`, `@scope/name`, either with `@version`. */
function packageSpec(s: string): boolean {
    const m = /^(@[a-z0-9][a-z0-9._-]*\/)?([a-z0-9][a-z0-9._-]*)(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/.exec(s);
    return m !== null && plainWord(m[2]!.replace(/^[0-9]+/, "x")) && s.length <= 100;
}

/**
 * Programs that fetch a package and run it, and the word each needs first to do that. Only these: any other program
 * (`node server.js`, `docker run …`) runs what's on this machine, or takes arguments that can't be told from a key.
 */
const RUNNERS: Record<string, string | undefined> = { npx: undefined, bunx: undefined, uvx: undefined, pnpm: "dlx", yarn: "dlx", pipx: "run" };
/** Options a runner takes that say nothing but how to run: none of them has a value. */
const RUNNER_FLAGS = new Set(["-y", "--yes", "-q", "--quiet", "--silent"]);

/**
 * An MCP server as it can go to another machine: the entry made again from
 * the parts that can't be holding a key, or undefined when it has to stay.
 * Told by what it IS, not by looking for keys in it (a key can sit anywhere:
 * in an address's path, after a short option, as a password in an address
 * given as an argument, in a field of some other tool's):
 *   - an address that's only a public host and a path, all in plain words; or
 *   - a package runner (`npx`, `uvx`, …), its own flags, and one package.
 * Nothing else of the entry is carried: no environment, headers, folder or
 * secret, and no field this doesn't know. The user is told which servers
 * stayed (CopyPlan.left).
 */
export function portableMcpEntry(c: McpServerConfig): McpServerConfig | undefined {
    if (c.plugin || c.env || c.headers || c.cwd || c.oauth?.clientSecret) return undefined;
    if (matchesSecretPattern(JSON.stringify(c))) return undefined;
    const kept: McpServerConfig = {};
    if (typeof c.type === "string" && ["stdio", "http", "streamable-http", "sse", "ws"].includes(c.type)) kept.type = c.type;
    if (c.disabled === true) kept.disabled = true;
    if (c.url) {
        if (c.command || c.args !== undefined || typeof c.url !== "string") return undefined;
        let u: URL;
        try {
            u = new URL(c.url);
        } catch {
            return undefined;
        }
        if (!/^(https?|wss?):$/.test(u.protocol) || u.username || u.password || u.search || u.hash || localHost(u.hostname)) return undefined;
        if (!u.hostname.split(".").every((label) => label.length <= 40 && !tokenLike(label))) return undefined;
        if (!u.pathname.split("/").filter(Boolean).every(plainWord)) return undefined;
        // Which client to sign in as is a name, not a secret (the secret, when there is one, kept the server here).
        const o = c.oauth;
        const oauth = {
            ...(typeof o?.clientId === "string" && o.clientId.length <= 200 ? { clientId: o.clientId } : {}),
            ...(typeof o?.callbackPort === "number" ? { callbackPort: o.callbackPort } : {}),
            ...(typeof o?.scopes === "string" || (Array.isArray(o?.scopes) && o.scopes.every((x) => typeof x === "string")) ? { scopes: o!.scopes } : {}),
        };
        return { ...kept, url: c.url, ...(Object.keys(oauth).length ? { oauth } : {}) };
    }
    if (typeof c.command !== "string" || !Object.hasOwn(RUNNERS, c.command)) return undefined;
    if (!Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) return undefined;
    const first = RUNNERS[c.command];
    const args = first === undefined ? c.args : c.args[0] === first ? c.args.slice(1) : undefined;
    if (!args?.length || !args.slice(0, -1).every((a) => RUNNER_FLAGS.has(a)) || !packageSpec(args.at(-1)!)) return undefined;
    return { ...kept, command: c.command, args: [...c.args] };
}

/** Whether an MCP server can go as it is (portableMcpEntry). */
export function portableMcpServer(c: McpServerConfig): boolean {
    return portableMcpEntry(c) !== undefined;
}

/**
 * A permission rule that can't be holding a key: a tool's name alone, or a
 * tool with words in plain characters, none of them an option (`-u …`), an
 * assignment (`TOKEN=…`), an address or anything quoted.
 */
export function portableRule(rule: string): boolean {
    if (matchesSecretPattern(rule)) return false;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/s.exec(rule);
    if (!m) return false;
    const body = m[2];
    if (body === undefined) return true;
    if (!/^[A-Za-z0-9 ._/*:~-]+$/.test(body) || body.includes("://")) return false;
    if (body.split(" ").some((w) => w.startsWith("-"))) return false;
    // An address needs no scheme to carry a token in its path or its name: no piece of a word reads like one.
    return !body.split(/[ /.:*]+/).some(tokenLike);
}

/** What a copy leaves on this machine because it could hold a key or needs this machine: said, so nothing is missed in silence. */
export interface LeftBehind {
    /** MCP servers, by name. */
    servers: string[];
    rules: number;
}

/** The settings a server gets: what's safe to carry, and nothing else. `left` is filled with what wasn't. */
export function portableSettings(s: Settings, left: LeftBehind = { servers: [], rules: 0 }): Settings {
    const out: Record<string, unknown> = {};
    for (const k of SETTINGS_KEYS) if (s[k] !== undefined) out[k] = s[k];
    const p = s.permissions;
    if (p) {
        // The rules, not the mode: what a server asks about is its own decision.
        const rules: Record<string, string[]> = {};
        for (const k of ["allow", "ask", "deny"] as const) {
            const all = (Array.isArray(p[k]) ? p[k]! : []).filter((r): r is string => typeof r === "string");
            const kept = all.filter(portableRule);
            left.rules += all.length - kept.length;
            if (kept.length) rules[k] = kept;
        }
        if (Object.keys(rules).length) out.permissions = rules;
    }
    const kept: Record<string, McpServerConfig> = {};
    for (const [name, c] of Object.entries(s.mcpServers ?? {})) {
        // Each as portableMcpEntry made it again, not as it was: what that didn't choose to carry doesn't go.
        const entry = c && typeof c === "object" ? portableMcpEntry(c) : undefined;
        if (entry) kept[name] = entry;
        else left.servers.push(name);
    }
    if (Object.keys(kept).length) out.mcpServers = kept;
    // Whatever else reads like a key (a model name wouldn't): that setting stays here.
    for (const k of Object.keys(out)) if (matchesSecretPattern(JSON.stringify(out[k]))) delete out[k];
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
    /** What's in the settings here and doesn't go. */
    left: LeftBehind;
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
        // The bytes read, not a copy of the entry: a file linked in from elsewhere (a dotfiles folder) goes as a file.
        writeFileSync(dest, body, { mode: statSync(from).mode & 0o777 });
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

    const left: LeftBehind = { servers: [], rules: 0 };
    const portable = settings ? portableSettings(settings, left) : {};
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
    return { stage: dir, counts, left, files: stage.files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What a set of copied files is, by kind: the paths are as they sit under the server's home. */
export function countCopied(paths: string[]): CopyPlan["counts"] {
    const skill = /^\.(cavvy|claude)\/skills\/[^/]+\/SKILL\.md$/;
    return {
        settings: paths.includes(".cavvy/settings.json"),
        memory: paths.filter((p) => /^\.cavvy\/[^/]+\.md$|^\.claude\/CLAUDE\.md$|^\.claude\/rules\/|^\.codex\/AGENTS\.md$/.test(p)).length,
        skills: paths.filter((p) => skill.test(p)).length,
        commands: paths.filter((p) => p.startsWith(".cavvy/commands/")).length,
    };
}

/** "settings, memory, 12 skills and 3 commands": what a plan carries, for the line that says so. */
export function describeCopy(c: CopyPlan["counts"]): string {
    const parts = [...(c.settings ? ["settings"] : []), ...(c.memory ? ["memory"] : []), ...(c.skills ? [`${c.skills} skill${c.skills === 1 ? "" : "s"}`] : []), ...(c.commands ? [`${c.commands} command${c.commands === 1 ? "" : "s"}`] : [])];
    if (parts.length <= 1) return parts[0] ?? "";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "2 MCP servers and 1 rule": what a plan leaves here, for the line that says so. Empty when nothing is. */
export function describeLeft(left: LeftBehind): string {
    const parts = [...(left.servers.length ? [`${left.servers.length} MCP server${left.servers.length === 1 ? "" : "s"}`] : []), ...(left.rules ? [`${left.rules} permission rule${left.rules === 1 ? "" : "s"}`] : [])];
    return parts.join(" and ");
}

/** Unpacks stdin beside the server's home and moves in each file that isn't there yet. */
const RECEIVE = `
set -e
umask 077
t=$(mktemp -d "\${TMPDIR:-/tmp}/cavvy-copy.XXXXXX")
trap 'rm -rf "$t"' EXIT
# A shell that dies of a signal skips that (dash does): ended by one, it leaves the ordinary way.
trap 'exit 1' HUP INT TERM
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

/** Sends a plan's files. Returns the ones the server took, as paths under its home (the rest were there already). */
export async function sendCopy(e: ServerEntry, plan: CopyPlan, signal?: AbortSignal): Promise<string[]> {
    if (!plan.files) return [];
    const tar = Bun.spawn(["tar", "-czf", "-", "-C", plan.stage, "."], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...childEnv(), COPYFILE_DISABLE: "1" } });
    const body = new Uint8Array(await new Response(tar.stdout).arrayBuffer());
    if ((await tar.exited) !== 0) throw new ServerError("Couldn't pack your settings to copy.");
    const r = await ssh(e, remoteSh(RECEIVE), { stdin: body, timeoutMs: 120_000, signal });
    if (r.code !== 0) throw new ServerError(`Couldn't copy your settings to ${hostOf(e)}: ${printable(r.stderr.trim().split("\n").at(-1) ?? `exit ${r.code}`)}`);
    return r.stdout
        .split("\n")
        .filter((l) => l.startsWith("copied="))
        .map((l) => l.slice("copied=".length));
}
