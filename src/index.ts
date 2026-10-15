// Harness CLI entry point. Start it through bin/harness (or the compiled
// binary), not `bun src/index.ts`: see bin/harness for why.
//
//   harness                      interactive session
//   harness "fix the tests"      interactive, starting with a prompt
//   harness -p "explain x"       one-shot, prints the result (headless)
//   harness auth add|list|remove manage API keys
//   harness models               combined model list from every provider
//   harness mcp list|add|remove  manage MCP servers
//   harness gui | serve          the desktop/browser GUI (see src/server/)

import { basename, dirname, join, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { APP_NAME, APP_TITLE, APP_VERSION, harnessHome, paths } from "./config/paths";
import { loadHarnessEnv, preloadKeys, getKey, setKey, removeKey, storageDescription } from "./auth/credentials";
import { detectKeyProvider, validateKey } from "./auth/detect";
import { EFFORT_LEVELS, loadScope, loadSettings, readJson, readJsonForUpdate, settingsPath, updateSettings, writeJson, type Effort, type McpServerConfig, type SettingsScope } from "./config/settings";
import { isTrusted, projectConfigSummary, trustFolder, trustForSession } from "./config/trust";
import { MODE_INFO, parseMode, type PermissionMode } from "./permissions/modes";
import { allProviders, getProvider, readAgentConfig, readVertexConfig, removeAgentConfig, removeVertexConfig, saveAgentConfig, saveVertexConfig, SEARCH_PROVIDERS, validGoogleAccount, validVertexLocation, validVertexProject } from "./providers/registry";
import { checkAgentCli, vendorOf } from "./backends/index";
import { checkVertex, gcloudAccounts } from "./auth/gcloud";
import { listAllModels, forgetClient } from "./providers/models";
import { formatPrice, formatTokens } from "./providers/pricing";
import { modelRef } from "./providers/types";
import { findSession, listSessions } from "./agent/session";
import { pruneFileHistory } from "./agent/checkpoints";
import { McpManager } from "./mcp/manager";
import { maskKey, redact } from "./util/redact";
import { bold, padEnd, theme, truncate } from "./ui/ansi";
import type { OutputFormat } from "./headless";

const HELP = `${bold(`${APP_TITLE} v${APP_VERSION}`)} — a coding agent for your terminal that works with any model provider.

${bold("Usage")}
  ${APP_NAME} [options] [prompt]          start an interactive session
  ${APP_NAME} -p [options] "prompt"       run one prompt and print the result
  ${APP_NAME} auth add [provider]          add an API key (read from stdin or a hidden prompt)
  ${APP_NAME} auth add vertex --project <id> [--location global] [--account <email>]
  ${APP_NAME} auth add claude-code|codex     use your Claude / ChatGPT plan through your installed CLI
                                         use Gemini on Google Cloud through gcloud (no key)
  ${APP_NAME} auth list                    show which providers have keys (values never shown)
  ${APP_NAME} auth remove <provider>       delete a stored key
  ${APP_NAME} models [--refresh] [--json]  list every model you can use, across providers
  ${APP_NAME} mcp list                     show MCP servers and connect to each
  ${APP_NAME} mcp add [opts] <name> -- <command> [args…]
  ${APP_NAME} mcp add --transport http [opts] <name> <url>
  ${APP_NAME} mcp remove <name> [--scope s]
  ${APP_NAME} gui                          open the GUI in your browser (${APP_NAME} gui --help)
  ${APP_NAME} serve                        run the GUI server without opening a browser

${bold("Options")}
  -p, --print                    non-interactive: print the response and exit
  -m, --model <provider:model>   model to use, e.g. anthropic:claude-opus-5-5, openai:gpt-6.1-sol
      --effort <level>           reasoning effort: ${EFFORT_LEVELS.join(", ")}
      --permission-mode <mode>   manual (default) | acceptEdits | plan | auto | bypassPermissions
      --dangerously-skip-permissions  start in bypass mode (only in sandboxes / containers)
      --allowedTools <rules>     extra allow rules, e.g. "Bash(npm test:*) Edit"
      --disallowedTools <rules>  extra deny rules
  -c, --continue                 continue the most recent session in this directory
  -r, --resume [id]              resume a session (picker when no id)
      --add-dir <path>           allow access to another directory (repeatable)
      --append-system-prompt <t> extra instructions appended to the system prompt
      --output-format <f>        with -p: text (default) | json | stream-json
      --max-turns <n>            stop each prompt after n model turns
      --verbose                  more detail (tool calls on stderr with -p)
  -v, --version                  print the version
  -h, --help                     show this help

${bold("Keys")}  Run ${APP_NAME} and use /login, or \`${APP_NAME} auth add\`. Keys are stored in the OS keychain
       (or ~/.harness/credentials.json with mode 600 when there is no keychain), and are only
       ever sent to their own provider. Environment variables like ANTHROPIC_API_KEY also work.`;

interface Flags {
    print: boolean;
    model?: string;
    effort?: Effort;
    mode?: PermissionMode;
    skipPermissions: boolean;
    continue: boolean;
    resume?: string | true;
    addDirs: string[];
    append?: string;
    outputFormat: OutputFormat;
    maxTurns?: number;
    verbose: boolean;
    allowed: string[];
    disallowed: string[];
    rest: string[];
}

function die(msg: string, code = 1): never {
    process.stderr.write(`${APP_NAME}: ${msg}\n`);
    process.exit(code);
}

/** Split a rules argument: "Bash(npm test:*) Edit,Read" -> three rules (spaces inside parens kept). */
function splitRules(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    let depth = 0;
    for (const ch of s) {
        if (ch === "(") depth++;
        if (ch === ")") depth = Math.max(0, depth - 1);
        if ((ch === "," || ch === " ") && depth === 0) {
            if (cur.trim()) out.push(cur.trim());
            cur = "";
        } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function parseFlags(argv: string[]): Flags {
    const f: Flags = { print: false, skipPermissions: false, continue: false, addDirs: [], outputFormat: "text", verbose: false, allowed: [], disallowed: [], rest: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const eq = a.indexOf("=");
        const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
        const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
        const value = (): string => {
            if (inline !== undefined) return inline;
            const v = argv[++i];
            if (v === undefined) die(`${name} needs a value`);
            return v;
        };
        switch (name) {
            case "-p":
            case "--print":
                f.print = true;
                break;
            case "-m":
            case "--model":
                f.model = value();
                break;
            case "--effort": {
                const v = value().toLowerCase();
                if (!(EFFORT_LEVELS as string[]).includes(v)) die(`--effort must be one of ${EFFORT_LEVELS.join(", ")}`);
                f.effort = v as Effort;
                break;
            }
            case "--permission-mode": {
                const m = parseMode(value());
                if (!m) die("--permission-mode must be one of default, acceptEdits, plan, auto, bypassPermissions");
                f.mode = m;
                break;
            }
            case "--dangerously-skip-permissions":
                f.skipPermissions = true;
                break;
            case "-c":
            case "--continue":
                f.continue = true;
                break;
            case "-r":
            case "--resume": {
                const next = inline ?? argv[i + 1];
                if (next !== undefined && !next.startsWith("-") && /^[0-9]{8}-[0-9]{6}-[0-9a-f]+$|^[0-9a-f-]{4,}$/.test(next)) {
                    f.resume = next;
                    if (inline === undefined) i++;
                } else f.resume = true;
                break;
            }
            case "--add-dir":
                f.addDirs.push(resolve(value()));
                break;
            case "--append-system-prompt":
                f.append = value();
                break;
            case "--output-format": {
                const v = value();
                if (v !== "text" && v !== "json" && v !== "stream-json") die("--output-format must be text, json or stream-json");
                f.outputFormat = v;
                break;
            }
            case "--max-turns": {
                const n = Number(value());
                if (!Number.isInteger(n) || n < 1) die("--max-turns must be a positive integer");
                f.maxTurns = n;
                break;
            }
            case "--verbose":
                f.verbose = true;
                break;
            case "--allowedTools":
            case "--allowed-tools":
                f.allowed.push(...splitRules(value()));
                break;
            case "--disallowedTools":
            case "--disallowed-tools":
                f.disallowed.push(...splitRules(value()));
                break;
            case "-v":
            case "--version":
                process.stdout.write(`${APP_VERSION}\n`);
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            case "-h":
            case "--help":
                process.stdout.write(HELP + "\n");
                process.exit(0);
            // eslint-disable-next-line no-fallthrough
            case "--":
                f.rest.push(...argv.slice(i + 1));
                i = argv.length;
                break;
            default:
                if (a.startsWith("-") && a.length > 1) die(`unknown option ${a} (see --help)`);
                f.rest.push(a);
        }
    }
    return f;
}

// ---------------------------------------------------------------------------
// Piped input for -p.

const STDIN_WAIT_MS = Number(process.env.HARNESS_STDIN_WAIT_MS) || 3000;

/**
 * With a prompt on the command line stdin is optional, and a parent process
 * that leaves the pipe open (without ever writing or closing it) mustn't hang
 * the run: wait a few seconds for the first bytes, then go on without.
 */
async function readPipedStdin(havePrompt: boolean): Promise<string> {
    if (!havePrompt) return (await Bun.stdin.text()).trim();
    const reader = Bun.stdin.stream().getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(STDIN_WAIT_MS).then(() => undefined)]);
    if (!first) {
        process.stderr.write(`${APP_NAME}: no input on stdin after ${STDIN_WAIT_MS / 1000}s, continuing without it. To pipe a slow command's output, save it to a file first; to skip stdin, add < /dev/null.\n`);
        void reader.cancel().catch(() => {});
        return "";
    }
    const chunks: Uint8Array[] = [];
    let r = first;
    while (!r.done) {
        chunks.push(r.value);
        r = await reader.read();
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
}

// ---------------------------------------------------------------------------
// Secret input for `auth add` (no echo).

async function readHidden(prompt: string): Promise<string> {
    if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
    process.stderr.write(prompt);
    return new Promise((resolveP) => {
        let buf = "";
        process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
        const done = (v: string) => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.off("data", onData);
            process.stderr.write("\n");
            resolveP(v);
        };
        const onData = (d: string) => {
            // bracketed paste markers, if the terminal sends them
            d = d.replace(/\x1b\[20[01]~/g, "");
            for (const ch of d) {
                if (ch === "\r" || ch === "\n") return done(buf.trim());
                if (ch === "\x03") {
                    process.stdin.setRawMode(false);
                    process.stderr.write("\n");
                    process.exit(130);
                }
                if (ch === "\x7f" || ch === "\b") {
                    if (buf.length) {
                        buf = buf.slice(0, -1);
                        process.stderr.write("\b \b");
                    }
                    continue;
                }
                if (ch >= " ") {
                    buf += ch;
                    process.stderr.write("•");
                }
            }
        };
        process.stdin.on("data", onData);
    });
}

/**
 * `auth add claude-code|codex`: turn on the user's own agent CLI after
 * checking it's installed and signed in (by asking the CLI). Signing in is
 * the CLI's own business; nothing secret is saved.
 */
async function addAgentCli(providerId: string): Promise<number> {
    const def = getProvider(providerId)!;
    process.stderr.write(`Checking ${def.name}… `);
    let st;
    try {
        st = await checkAgentCli(providerId);
    } catch (e) {
        process.stderr.write(theme.error("failed\n"));
        die(redact((e as Error).message));
    }
    if (!st.installed) {
        process.stderr.write(theme.error("not installed\n"));
        die(`${st.installHint}, sign in with \`${st.signIn}\`, then run this again.`);
    }
    if (!st.signedIn) {
        process.stderr.write(theme.error("not signed in\n"));
        die(`run \`${st.signIn}\` (${vendorOf(providerId)}'s own sign-in), then run this again.`);
    }
    process.stderr.write(theme.success(`${st.description}\n`));
    try {
        saveAgentConfig(providerId);
    } catch (e) {
        die(redact((e as Error).message));
    }
    forgetClient(providerId);
    process.stdout.write(`Turned on ${def.name} (${st.path}). Its sign-in stays in ${def.name}; nothing secret is stored. Pick a model with: ${APP_NAME} models ${providerId}\n`);
    if (st.apiKey) process.stderr.write(`note: ${def.name} is signed in with an API key, so usage is billed to that key, not a subscription.\n`);
    return 0;
}

/** `auth add vertex`: save a gcloud-based setup after checking it. */
async function addVertexCli(args: string[]): Promise<number> {
    const flag = (name: string) => {
        const i = args.indexOf(`--${name}`);
        const eq = args.find((a) => a.startsWith(`--${name}=`));
        return eq ? eq.slice(name.length + 3) : i >= 0 ? args[i + 1] : undefined;
    };
    const project = flag("project");
    const location = flag("location") ?? "global";
    if (!project) die(`usage: ${APP_NAME} auth add vertex --project <id> [--location global] [--account <email>]`);
    if (!validVertexProject(project)) die(`"${project}" isn't a project ID (lowercase letters, digits and hyphens)`);
    if (!validVertexLocation(location)) die(`"${location}" isn't a location (global, or a region like us-central1)`);
    let account = flag("account");
    try {
        if (!account) {
            account = (await gcloudAccounts()).find((a) => a.active)?.account;
            if (!account) die("gcloud has no active account; run gcloud auth login, or pass --account");
        }
        if (!validGoogleAccount(account)) die(`"${account}" isn't a Google account`);
        const cfg = { project, location, account };
        process.stderr.write(`Checking Vertex AI in ${project} as ${account}… `);
        const r = await checkVertex(cfg);
        if (r.ok) process.stderr.write(theme.success(`ok (${r.models} models)\n`));
        else if (r.apiDisabled) {
            process.stderr.write(theme.error("API off\n"));
            die(`the Vertex AI API is off in ${project}. Turn it on with: gcloud services enable aiplatform.googleapis.com --project=${project}`);
        } else if (r.definitive) {
            process.stderr.write(theme.error("failed\n"));
            die(`${redact(r.reason).replace(/[.\s]*$/, ".")} Nothing was saved.`);
        } else process.stderr.write(theme.warning(`couldn't check (${redact(r.reason)}); saving anyway\n`));
        saveVertexConfig(cfg);
    } catch (e) {
        die(redact((e as Error).message));
    }
    forgetClient("vertex");
    process.stdout.write(`Saved Vertex AI: project ${project} (${location}) as ${account}. Usage is billed to ${project}; nothing secret is stored.\n`);
    return 0;
}

async function authCommand(args: string[]): Promise<number> {
    const [sub, arg] = args;
    if (sub === "list" || !sub) {
        process.stdout.write(`Keys are stored in ${await storageDescription()}\n\n`);
        for (const p of [...allProviders().filter((x) => x.requiresKey), ...SEARCH_PROVIDERS]) {
            if ("auth" in p && p.auth === "gcloud") {
                const cfg = readVertexConfig();
                process.stdout.write(`  ${padEnd(p.name, 22)}${padEnd(p.id, 14)}${cfg ? theme.success(`✔ gcloud  (${cfg.project}, ${cfg.location}, as ${cfg.account})`) : theme.subtle("—")}\n`);
                continue;
            }
            if ("auth" in p && p.auth === "cli") {
                process.stdout.write(`  ${padEnd(p.name, 22)}${padEnd(p.id, 14)}${readAgentConfig(p.id) ? theme.success(`✔ on  (signed in through ${p.name} itself)`) : theme.subtle("—")}\n`);
                continue;
            }
            const k = await getKey(p.id);
            process.stdout.write(`  ${padEnd(p.name, 22)}${padEnd(p.id, 14)}${k ? theme.success(`✔ ${maskKey(k.value)}  (${k.source === "env" ? `$${k.envVar}` : k.source})`) : theme.subtle("—")}\n`);
        }
        return 0;
    }
    if (sub === "add" && arg?.toLowerCase() === "vertex") return addVertexCli(args.slice(2));
    if (sub === "add" && arg && getProvider(arg.toLowerCase())?.auth === "cli") return addAgentCli(arg.toLowerCase());
    if ((sub === "remove" || sub === "rm" || sub === "logout") && arg && getProvider(arg.toLowerCase())?.auth === "cli") {
        const id = arg.toLowerCase();
        let removed = false;
        try {
            removed = removeAgentConfig(id);
        } catch (e) {
            die(redact((e as Error).message));
        }
        forgetClient(id);
        process.stdout.write(removed ? `Turned off ${getProvider(id)!.name} (it stays signed in; ${id === "codex" ? "codex logout" : "claude auth logout"} signs it out)\n` : `${getProvider(id)!.name} isn't turned on\n`);
        return removed ? 0 : 1;
    }
    if ((sub === "remove" || sub === "rm" || sub === "logout") && arg?.toLowerCase() === "vertex") {
        let removed = false;
        try {
            removed = removeVertexConfig();
        } catch (e) {
            die(redact((e as Error).message));
        }
        forgetClient("vertex");
        process.stdout.write(removed ? "Removed the Vertex AI setup (gcloud stays signed in)\n" : "Vertex AI isn't set up\n");
        return removed ? 0 : 1;
    }
    if (sub === "add") {
        let providerId = arg?.toLowerCase();
        if (providerId && !getProvider(providerId) && !SEARCH_PROVIDERS.some((s) => s.id === providerId)) die(`unknown provider "${providerId}". Known: ${[...allProviders().map((p) => p.id), ...SEARCH_PROVIDERS.map((s) => s.id)].join(", ")}`);
        const key = await readHidden(`Paste ${providerId ? `the ${providerId}` : "an"} API key (hidden): `);
        if (!key) die("no key given");
        if (/\s/.test(key)) die("that doesn't look like a single key");
        if (!providerId) {
            const guesses = detectKeyProvider(key);
            if (guesses.length !== 1) die(guesses.length ? `the key could belong to ${guesses.map((g) => g.id).join(" or ")}; run \`${APP_NAME} auth add <provider>\`` : `couldn't tell which provider this key is for; run \`${APP_NAME} auth add <provider>\``);
            providerId = guesses[0]!.id;
        }
        const def = getProvider(providerId);
        if (def) {
            process.stderr.write(`Checking the key with ${def.name}… `);
            const r = await validateKey(def, key);
            if (r.ok) process.stderr.write(theme.success("ok\n"));
            else if (r.definitive) {
                process.stderr.write(theme.error("rejected\n"));
                die(`${def.name} rejected the key (${redact(r.reason)}); nothing was saved`);
            } else process.stderr.write(theme.warning(`couldn't verify (${redact(r.reason)}); saving anyway\n`));
        }
        const source = await setKey(providerId, key);
        forgetClient(providerId);
        process.stdout.write(`Saved ${providerId} key ${maskKey(key)} to ${source === "keychain" ? await storageDescription() : paths.credentialsFile()}\n`);
        const eff = await getKey(providerId);
        if (eff?.source === "env") process.stderr.write(`note: $${eff.envVar} is set and takes precedence over the saved key\n`);
        return 0;
    }
    if (sub === "remove" || sub === "rm" || sub === "logout") {
        if (!arg) die(`usage: ${APP_NAME} auth remove <provider>`);
        const k = await getKey(arg);
        if (k?.source === "env") die(`the ${arg} key comes from $${k.envVar}; unset it in your shell`);
        const removed = await removeKey(arg);
        forgetClient(arg);
        process.stdout.write(removed ? `Removed the ${arg} key\n` : `No stored key for ${arg}\n`);
        return removed ? 0 : 1;
    }
    die(`unknown auth command "${sub}" (add, list, remove)`);
}

async function modelsCommand(args: string[]): Promise<number> {
    const refresh = args.includes("--refresh");
    const asJson = args.includes("--json");
    const filter = args.find((a) => !a.startsWith("-"));
    const listings = await listAllModels({ refresh });
    if (asJson) {
        process.stdout.write(JSON.stringify(listings.flatMap((l) => l.models.map((m) => ({ ref: modelRef(m), ...m }))), null, 2) + "\n");
        return 0;
    }
    if (!listings.length) {
        process.stderr.write(`No providers configured. Add a key with \`${APP_NAME} auth add\` or start Ollama / LM Studio.\n`);
        return 1;
    }
    for (const l of listings) {
        if (filter && l.provider.id !== filter) continue;
        if (l.status === "offline") continue;
        process.stdout.write(`\n${bold(l.provider.name)}${l.status === "cached" ? theme.subtle(" (cached)") : ""}${l.status === "error" ? theme.error(`  ${l.error}`) : ""}\n`);
        for (const m of l.models) {
            process.stdout.write(`  ${padEnd(truncate(modelRef(m), 56), 58)}${padEnd(m.contextWindow ? formatTokens(m.contextWindow) : "", 8)}${theme.muted(formatPrice(m))}\n`);
        }
    }
    process.stdout.write(theme.subtle(`\nPrices are USD per million input/output tokens; ~ means borrowed from OpenRouter's catalog.\n`));
    return 0;
}

async function mcpCli(args: string[], cwd: string): Promise<number> {
    const sub = args[0];
    if (sub === "list" || !sub) {
        const trusted = isTrusted(cwd);
        const settings = loadSettings(cwd, { trusted });
        const mgr = new McpManager(cwd, () => settings, trusted);
        mgr.load();
        if (!mgr.servers.size) {
            process.stdout.write("No MCP servers configured.\n");
            return 0;
        }
        await Promise.race([mgr.startAll(), new Promise((r) => setTimeout(r, 20_000))]);
        for (const s of mgr.servers.values()) {
            const target = s.config.url ?? `${s.config.command ?? ""} ${(s.config.args ?? []).join(" ")}`;
            const status = s.status === "connected" ? theme.success(`✔ ${s.tools.length} tools · ${s.era ?? ""}`) : s.status === "failed" ? theme.error(`✘ ${(s.error ?? "").split("\n")[0]}`) : theme.warning(s.status);
            process.stdout.write(`  ${padEnd(bold(s.name), 20)}${padEnd(theme.muted(truncate(target, 50)), 52)}${status}\n`);
        }
        await mgr.closeAll();
        return 0;
    }
    if (sub === "add") {
        let scope: SettingsScope = "user";
        let transport: "stdio" | "http" = "stdio";
        const env: Record<string, string> = {};
        const headers: Record<string, string> = {};
        const pos: string[] = [];
        let tail: string[] = [];
        for (let i = 1; i < args.length; i++) {
            const a = args[i]!;
            if (a === "--") {
                tail = args.slice(i + 1);
                break;
            }
            if (a === "--scope" || a === "-s") scope = (args[++i] ?? "user") as SettingsScope;
            else if (a === "--transport" || a === "-t") transport = (args[++i] ?? "stdio") === "http" ? "http" : "stdio";
            else if (a === "-e" || a === "--env") {
                const kv = args[++i] ?? "";
                const idx = kv.indexOf("=");
                if (idx <= 0) die("-e expects KEY=value");
                env[kv.slice(0, idx)] = kv.slice(idx + 1);
            } else if (a === "-H" || a === "--header") {
                const hv = args[++i] ?? "";
                const idx = hv.indexOf(":");
                if (idx <= 0) die('-H expects "Name: value"');
                headers[hv.slice(0, idx).trim()] = hv.slice(idx + 1).trim();
            } else pos.push(a);
        }
        if (!["user", "project", "local"].includes(scope)) die("--scope must be user, project or local");
        const name = pos[0];
        if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) die("give the server a name (letters, digits, _ and -)");
        let cfg: McpServerConfig;
        if (transport === "http") {
            const url = pos[1];
            if (!url) die(`usage: ${APP_NAME} mcp add --transport http <name> <url>`);
            cfg = { url, ...(Object.keys(headers).length ? { headers } : {}) };
        } else {
            const cmd = tail.length ? tail : pos.slice(1);
            if (!cmd.length) die(`usage: ${APP_NAME} mcp add <name> -- <command> [args…]`);
            cfg = { command: cmd[0]!, args: cmd.slice(1), ...(Object.keys(env).length ? { env } : {}) };
        }
        if (scope === "project") {
            // project scope = the shared .mcp.json, like other tools use
            const file = paths.projectMcp(cwd);
            try {
                const f = readJsonForUpdate<{ mcpServers?: Record<string, McpServerConfig> }>(file) ?? {};
                (f.mcpServers ??= {})[name] = cfg;
                writeJson(file, f);
                updateSettings("local", cwd, (s) => (s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers ?? []), name])]));
            } catch (e) {
                die((e as Error).message);
            }
            process.stdout.write(`Added ${name} to ${file}\n`);
        } else {
            try {
                updateSettings(scope, cwd, (s) => ((s.mcpServers ??= {})[name] = cfg));
            } catch (e) {
                die((e as Error).message);
            }
            process.stdout.write(`Added ${name} to ${settingsPath(scope, cwd)}\n`);
        }
        if (Object.keys(env).length || Object.keys(headers).length) process.stderr.write(`note: env values and headers are stored in plain text in that file.\n`);
        return 0;
    }
    if (sub === "remove" || sub === "rm") {
        const name = args[1];
        if (!name) die(`usage: ${APP_NAME} mcp remove <name> [--scope s]`);
        const scopeIdx = args.indexOf("--scope");
        const scopes: SettingsScope[] = scopeIdx > 0 ? [args[scopeIdx + 1] as SettingsScope] : ["local", "project", "user"];
        let removed = false;
        for (const scope of scopes) {
            const s = loadScope(scope, cwd);
            if (s.mcpServers?.[name]) {
                try {
                    updateSettings(scope, cwd, (x) => delete x.mcpServers?.[name]);
                } catch (e) {
                    die((e as Error).message);
                }
                process.stdout.write(`Removed ${name} from ${settingsPath(scope, cwd)}\n`);
                removed = true;
            }
        }
        const f = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(paths.projectMcp(cwd));
        if ((scopeIdx < 0 || args[scopeIdx + 1] === "project") && f?.mcpServers?.[name]) {
            delete f.mcpServers[name];
            writeJson(paths.projectMcp(cwd), f);
            process.stdout.write(`Removed ${name} from ${paths.projectMcp(cwd)}\n`);
            removed = true;
        }
        if (!removed) die(`no MCP server named ${name}`);
        return 0;
    }
    die(`unknown mcp command "${sub}" (list, add, remove)`);
}

// ---------------------------------------------------------------------------
// Trust prompt (only when the folder has project config that could run code).

async function askTrust(cwd: string, found: string[]): Promise<boolean> {
    const { Screen } = await import("./ui/screen");
    const { SelectDialog } = await import("./ui/dialogs");
    const screen = new Screen();
    const d = new SelectDialog<"yes" | "no">({
        title: "Do you trust the files in this folder?",
        header: [
            bold(cwd),
            "",
            `This folder has configuration ${APP_TITLE} would use: ${found.join(", ")}.`,
            theme.muted("Project settings can define hooks and MCP servers that run commands on your machine,"),
            theme.muted("and permission rules that let the model act without asking."),
            "",
            theme.muted("If you don't trust it, those files are ignored (except deny/ask rules, which only add restrictions),"),
            theme.muted("and so are its memory files (HARNESS.md, AGENTS.md, CLAUDE.md)."),
        ],
        items: [
            { label: "Yes, trust this folder", value: "yes" },
            { label: "No, ignore its configuration", value: "no" },
        ],
        numbers: true,
        color: theme.warning,
    });
    const render = () => screen.setLive(["", ...d.render(Math.min(process.stdout.columns || 100, 100), process.stdout.rows || 40)]);
    screen.start(
        (k) => {
            if (k.ctrl && k.name === "c") d.cancel();
            else d.onKey(k);
            render();
        },
        render,
    );
    render();
    const v = await d.done;
    screen.setLive([]);
    screen.flushNow();
    screen.stop();
    return v === "yes";
}

// ---------------------------------------------------------------------------

async function main() {
    const argv = process.argv.slice(2);
    const cwd = process.cwd();

    // Only the harness's own env files (never the project's .env; Bun's auto-load is off).
    const installDir = dirname(import.meta.dir);
    const env = loadHarnessEnv([join(harnessHome(), ".env"), join(installDir, ".env")]);
    await preloadKeys();

    const sub = argv[0];
    if (sub === "auth") process.exit(await authCommand(argv.slice(1)));
    if (sub === "models") process.exit(await modelsCommand(argv.slice(1)));
    if (sub === "mcp") process.exit(await mcpCli(argv.slice(1), cwd));
    if (sub === "gui" || sub === "serve") {
        const { serveCommand } = await import("./server/cli");
        return serveCommand(sub, argv.slice(1), { fallbackModel: env.legacyModel, notes: env.notes });
    }

    const f = parseFlags(argv);
    const interactive = !f.print && Boolean(process.stdin.isTTY && process.stdout.isTTY);

    let prompt = f.rest.join(" ").trim();
    if (!process.stdin.isTTY && (f.print || !interactive)) {
        const piped = await readPipedStdin(Boolean(prompt));
        if (piped) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped}\n</stdin>` : piped;
    }
    if (!interactive && !prompt) die('no prompt given. Use -p "your prompt" (or pipe text on stdin) for non-interactive runs.');

    // Trust
    let trusted = isTrusted(cwd);
    const found = projectConfigSummary(cwd);
    if (!trusted && found.length) {
        if (interactive) {
            trusted = await askTrust(cwd, found);
            if (trusted) {
                try {
                    trustFolder(cwd);
                } catch (e) {
                    env.notes.push(`Trusted for this session only. ${(e as Error).message}`);
                }
            }
        } else process.stderr.write(`warning: this folder isn't trusted, so ${found.join(", ")} and its memory files are ignored (except deny/ask rules). Run ${APP_NAME} interactively once to trust it.\n`);
    } else if (!trusted) {
        // Nothing to protect yet. Anything created later this session (like a
        // "don't ask again" rule) comes from the user, so honor it.
        trustForSession(cwd);
        trusted = true;
    }

    // Permission mode: flags > settings. Bypass from settings only counts from the user's own file.
    const settings = loadSettings(cwd, { trusted });
    const notes = [...env.notes];
    let mode: PermissionMode = f.mode ?? settings.permissions?.defaultMode ?? "default";
    if (!f.mode && mode === "bypassPermissions" && loadScope("user", cwd).permissions?.defaultMode !== "bypassPermissions") {
        notes.push("Ignored defaultMode bypassPermissions from project settings; only your user settings or --dangerously-skip-permissions can enable it.");
        mode = "default";
    }
    if (f.skipPermissions) mode = "bypassPermissions";
    const allowBypass = f.skipPermissions || f.mode === "bypassPermissions" || Boolean(loadScope("user", cwd).permissions?.allowBypass) || mode === "bypassPermissions";

    // Session to resume
    let resumeFile: string | undefined;
    if (f.continue) {
        resumeFile = listSessions(cwd, 1)[0]?.file;
        if (!resumeFile) notes.push("No earlier session in this directory to continue; starting a new one.");
    } else if (typeof f.resume === "string") {
        resumeFile = findSession(cwd, f.resume);
        if (!resumeFile) die(`no session matching "${f.resume}" in this directory`);
    }
    // File snapshots of sessions untouched for 30 days (the one being resumed stays).
    void pruneFileHistory({ keep: resumeFile && basename(resumeFile, ".jsonl") });

    if (!interactive) {
        if (f.resume === true) die("--resume without an id needs an interactive terminal; pass a session id or use --continue");
        const { runHeadless } = await import("./headless");
        const code = await runHeadless({
            cwd,
            prompt,
            trusted,
            modelRef: f.model,
            mode,
            outputFormat: f.outputFormat,
            verbose: f.verbose,
            maxTurns: f.maxTurns,
            allowedTools: f.allowed,
            disallowedTools: f.disallowed,
            appendSystemPrompt: f.append,
            resumeFile,
            addDirs: f.addDirs,
            startupNotes: notes,
            effort: f.effort,
            fallbackModel: env.legacyModel,
        });
        process.exit(code);
    }

    if (mode === "bypassPermissions") notes.push(`${MODE_INFO.bypassPermissions.label} is on: tools run without asking (deny rules and catastrophic-command guards still apply).`);
    const { App } = await import("./ui/app");
    const app = new App({
        cwd,
        trusted,
        mode,
        allowBypass,
        modelRef: f.model,
        resumeFile,
        resumePicker: f.resume === true,
        initialPrompt: prompt || undefined,
        appendSystemPrompt: f.append,
        maxTurns: f.maxTurns,
        startupNotes: notes,
        extraAllow: f.allowed,
        extraDeny: f.disallowed,
        addDirs: f.addDirs,
        effort: f.effort,
        fallbackModel: env.legacyModel,
    });
    process.on("uncaughtException", (e) => {
        app.screen.stop();
        process.stderr.write(`\n${APP_NAME} crashed: ${redact(e?.stack ?? String(e))}\n`);
        process.exit(1);
    });
    process.on("unhandledRejection", (e) => {
        app.notice(`Internal error: ${redact((e as Error)?.message ?? String(e))}`, "error");
    });
    await app.run();
}

void main();
