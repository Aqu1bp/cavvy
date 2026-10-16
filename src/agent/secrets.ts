// Secrets the user typed in for one session (RequestSecret, request_secret).
// The value lives here and nowhere else: it goes into the environment of
// that session's Bash processes (and run_with_secrets), and the model, the
// transcript, hooks and every window only ever see its name. Redaction is
// the backstop for output that prints it.

import { knownSecrets, registerSecret } from "../util/redact";
import { secretEnvVarNames } from "../auth/credentials";

export const MAX_SECRET_BYTES = 8 * 1024;
/** registerSecret ignores anything shorter; a shorter value couldn't be kept out of the output. */
export const MIN_SECRET_LENGTH = 8;
export const MAX_PURPOSE = 500;

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

// Variables that change how a shell, a runtime or a tool runs, or that the
// harness sets itself: a "secret" by one of these names would be a way in.
const RESERVED = new Set([
    "PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "TMPDIR", "TERM", "LANG", "TZ", "IFS", "ENV", "CDPATH", "FPATH", "MANPATH",
    "PS1", "PS2", "PS3", "PS4", "PROMPT_COMMAND", "SHELLOPTS", "GLOBIGNORE", "HISTFILE", "ZDOTDIR", "MAIL", "MAILPATH",
    "PAGER", "EDITOR", "VISUAL", "BROWSER", "SSH_AUTH_SOCK", "SSH_ASKPASS", "SUDO_ASKPASS", "DISPLAY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "CURL_HOME", "WGETRC",
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "CLASSPATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "GOFLAGS", "RUSTFLAGS", "CARGO_HOME", "RUSTUP_HOME",
    "PERL5LIB", "PERL5OPT", "PERLLIB", "RUBYOPT", "RUBYLIB", "COREPACK_HOME", "UV_CACHE_DIR", "PIP_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
]);
const RESERVED_PREFIXES = ["LD_", "DYLD_", "GIT_", "HARNESS", "BASH_", "ZSH_", "LC_", "NPM_CONFIG_", "BUN_", "PYTHON", "CLAUDE_", "CODEX_", "ANTHROPIC_", "OPENAI_"];

/** Why `name` can't be a secret's name, or undefined if it can. */
export function secretNameError(name: unknown): string | undefined {
    if (typeof name !== "string" || !NAME.test(name)) return "name must be an environment variable name: capital letters, digits and underscores, starting with a letter, at most 64 characters (e.g. GITHUB_TOKEN).";
    if (RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p)) || secretEnvVarNames().includes(name)) {
        return `${name} changes how programs run or belongs to Harness, so it can't hold a secret. Pick a name of its own (e.g. MY_SERVICE_TOKEN) and use it in the command.`;
    }
    return undefined;
}

/** Why `value` can't be stored. Never quotes the value. */
export function secretValueError(value: unknown): string | undefined {
    if (typeof value !== "string") return "The value must be text.";
    if (value.length < MIN_SECRET_LENGTH) return `The value is shorter than ${MIN_SECRET_LENGTH} characters, too short to keep out of the output.`;
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) return `The value is longer than ${MAX_SECRET_BYTES / 1024} KiB.`;
    // Output is redacted a line at a time as it streams, so a value can't span lines.
    if (/[\0\r\n]/.test(value)) return "The value can't contain line breaks or NUL characters.";
    return undefined;
}

/** The purpose as it can be shown: one line of plain text, or why it can't. Not yet redacted. */
export function cleanPurpose(purpose: unknown): { text: string } | { error: string } {
    if (typeof purpose !== "string") return { error: "purpose must be a string: one or two sentences on what the secret is for." };
    // Control and bidi characters would let the model's words restyle a terminal or hide text.
    const text = purpose.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return { error: "purpose must say what the secret is for." };
    if (text.length > MAX_PURPOSE) return { error: `purpose must be at most ${MAX_PURPOSE} characters.` };
    return { text };
}

/**
 * The forms of a value worth catching in output, each unbroken: as is; URL-encoded the common ways
 * (encodeURIComponent, Python's quote with its "/" left alone, a form's "+" for spaces); base64 and
 * base64url (`echo $X | base64` adds the newline). Anything else, such as base64 wrapped across lines, isn't.
 */
function forms(value: string): string[] {
    const uri = encodeURIComponent(value);
    const quote = uri.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const b64 = (s: string) => Buffer.from(s).toString("base64").replace(/=+$/, "");
    const b64url = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_");
    return [...new Set([value, uri, quote, quote.replace(/%2F/g, "/"), quote.replace(/%20/g, "+"), b64(value), b64(value + "\n"), b64url(value), b64url(value + "\n")])];
}

/** Every form of every value any session was given: they stay redacted, and out of Harness's own copies of files, for as long as it runs. */
const given = new Set<string>();

/** Whether `data` holds a value a user gave (in any form above). */
export function holdsGivenSecret(data: Buffer | string): boolean {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    for (const f of given) if (buf.includes(f)) return true;
    return false;
}

/** One session's secrets, by name. Shared with its sub-agents (they act for the same session). */
export class SecretStore {
    private values = new Map<string, string>();
    private listeners = new Set<() => void>();

    /** Stores (or replaces) a secret. Its value is redacted everywhere for as long as the process lives. */
    set(name: string, value: string) {
        const bad = secretNameError(name) ?? secretValueError(value);
        if (bad) throw new Error(bad);
        // A value another session (or a provider key) registered keeps its label, so one session's names don't show in another's output.
        const known = new Set(knownSecrets());
        for (const f of forms(value)) {
            given.add(f);
            if (!known.has(f)) registerSecret(f, name);
        }
        this.values.set(name, value);
        this.changed();
    }

    /** Stops handing it to new processes. Its value stays redacted: a file the agent wrote it into can still be read. */
    forget(name: string): boolean {
        const had = this.values.delete(name);
        if (had) this.changed();
        return had;
    }

    clear() {
        if (!this.values.size) return;
        this.values.clear();
        this.changed();
    }

    has(name: string): boolean {
        return this.values.has(name);
    }

    names(): string[] {
        return [...this.values.keys()].sort();
    }

    /** A store with just `names` (already registered, so not again), for one command. */
    only(names: string[]): SecretStore {
        const out = new SecretStore();
        for (const n of names) {
            const v = this.values.get(n);
            if (v !== undefined) out.values.set(n, v);
        }
        return out;
    }

    /** For a child process's environment: all of them, or just `names`. */
    env(names?: string[]): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of this.values) if (!names || names.includes(k)) out[k] = v;
        return out;
    }

    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private changed() {
        for (const fn of this.listeners) fn();
    }
}

export type SecretAsk = (name: string, purpose: string, signal: AbortSignal) => Promise<string | undefined>;

/**
 * Asks the user for a secret and stores it. What comes back is for the model:
 * a handle (the name), never the value. `using` says how the agent uses it.
 */
export async function requestSecret(o: { store?: SecretStore; ask?: SecretAsk; name: string; purpose: string; signal: AbortSignal; using: "bash" | "run_with_secrets" }): Promise<{ text: string; isError?: boolean; provided: boolean }> {
    const { name } = o;
    const again = "Don't ask for it again unless the user brings it up.";
    if (!o.store || !o.ask) return { text: `Can't ask for ${name}: no one is here to type it in (non-interactive session). Nothing was provided. ${again}`, isError: true, provided: false };
    const value = await o.ask(name, o.purpose, o.signal);
    if (o.signal.aborted) return { text: `The request for ${name} was interrupted. Nothing was provided. ${again}`, provided: false };
    if (value === undefined) return { text: `The user didn't provide ${name}. Nothing was stored. ${again} Carry on without it, or say what you couldn't do.`, provided: false };
    o.store.set(name, value);
    const use =
        o.using === "bash"
            ? `Shell commands (Bash) in this session see it as $${name}: refer to it by that name in the command.`
            : `Run commands that need it with the harness run_with_secrets tool (secrets: ["${name}"]) and refer to it as $${name} in the command. Your own shell doesn't have it.`;
    return {
        text: `The user provided ${name}. ${use} Its value is never shown to you: wherever it appears in output it's replaced with a [REDACTED …] marker. Don't try to print, encode or copy it elsewhere. It's kept only while this session is open; if a command finds it empty, ask again.`,
        provided: true,
    };
}
