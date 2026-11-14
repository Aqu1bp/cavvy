// How to sign in to things, as data: for each, how to tell whether it's signed
// in, the command that signs in on a machine with the person's browser and the
// one for when their browser is elsewhere, which kind of flow that command is,
// and what to read from its output. Cavvy runs these itself (sign-in.ts); an
// agent only ever names one. Adding a service is adding an entry here, or one
// of the user's own in settings (`signIns`).

/**
 * The kinds of sign-in a command can be:
 * - browser: it opens the browser on its own machine and finishes by itself.
 * - device: it prints a code to enter on a web page, and finishes by itself.
 * - paste: the web page gives a code to type back at its prompt.
 * - callback: the web page ends by calling a port on the CLI's own machine, which is another machine than the
 *   browser's: that port is forwarded, and then it's "browser".
 * - token: it reads a token from its input.
 * - typed: it asks for a name and a password at prompts of its own.
 */
export type SignInFlowKind = "browser" | "device" | "paste" | "callback" | "token" | "typed";

export const SIGN_IN_FLOWS: readonly SignInFlowKind[] = ["browser", "device", "paste", "callback", "token", "typed"];

export interface SignInWay {
    flow: SignInFlowKind;
    /** The command, as words: no shell reads it. */
    run: string;
    /** For "callback": the port its page calls. */
    port?: number;
}

export interface SignInRecipe {
    /** What an agent names: "gh". */
    id: string;
    /** What the card says: "GitHub". */
    name: string;
    aliases?: string[];
    /**
     * How to tell it's signed in. Signed in when `signedIn` (a pattern) is found in what `run` prints, or, without
     * one, when it exits with 0. `who`: a pattern whose first group is the account.
     */
    status: { run: string; signedIn?: string; who?: string };
    /** On a machine with the person's browser. */
    here: SignInWay;
    /** When their browser is on another machine (a server). Left out: `here` works there too, unless it's "browser". */
    away?: SignInWay;
    /** Signing in with a token instead: a command that reads it from its input, and the page that makes one. */
    token?: { run: string; url?: string };
    /** Set for its commands. */
    env?: Record<string, string>;
    /**
     * Patterns over what the sign-in prints: the first group of `url` (the last link that fits, any link without
     * a pattern) and of `code`; `prompt`, the whole of what it
     * prints when it's waiting for the pasted code; `expired` when the code is no longer good.
     */
    reads?: { url?: string; code?: string; prompt?: string; expired?: string };
    /** What to answer when it asks something on the way ("Press Enter"): the first pattern found, once each. */
    answers?: { when: string; send: string }[];
    /** A command to run once it's signed in. */
    then?: string;
    /** One line for the card when it's on a server: what agents there can then do. */
    warning?: string;
    /** In any command's output: this isn't signed in (the agent is then told to ask). */
    signedOut?: string[];
    /** One of the agent CLIs (src/backends/defs.ts): its own path, options and account are used. */
    provider?: string;
}

const CODE = "\\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\\b";

/** Checked by running each CLI, signed out and signed in (see docs/sign-in.md for what each was seen to print). */
export const SIGN_IN_RECIPES: readonly SignInRecipe[] = [
    {
        id: "gh",
        name: "GitHub",
        aliases: ["github", "git"],
        status: { run: "gh auth status --hostname github.com", who: "account (\\S+)" },
        here: { flow: "device", run: "gh auth login --hostname github.com --git-protocol https --web" },
        token: { run: "gh auth login --hostname github.com --git-protocol https --with-token", url: "https://github.com/settings/personal-access-tokens/new" },
        // Without this it asks questions of its own before the code.
        env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        reads: { code: CODE, url: "(https://github\\.com/login/device)", expired: "expired|timed out" },
        then: "gh auth setup-git --hostname github.com",
        warning: "Agents there can push as you",
        signedOut: ["not logged into any GitHub hosts", "gh auth login", "could not read Username for 'https://github\\.com", "Authentication failed for 'https://github\\.com"],
    },
    {
        id: "aws",
        name: "AWS",
        aliases: ["amazon"],
        status: { run: "aws sts get-caller-identity --query Account --output text", signedIn: "^\\d{12}\\s*$", who: "\\d{8}(\\d{4})" },
        here: { flow: "browser", run: "aws login" },
        away: { flow: "paste", run: "aws login --remote" },
        reads: { url: "(https://\\S*signin\\.\\S+)", prompt: "Enter the authorization code[^:]*:" },
        // With no region configured it asks for one first: the one it offers is taken.
        answers: [{ when: "AWS Region \\[[^\\]]*\\]:", send: "\r" }],
        signedOut: ["Unable to locate credentials", "ExpiredToken", "Your session has expired", "aws login"],
    },
    {
        id: "gcloud",
        name: "Google Cloud",
        aliases: ["gcp", "google"],
        status: { run: "gcloud auth list --filter=status:ACTIVE --format=value(account)", signedIn: "\\S+@\\S+", who: "(\\S+@\\S+)" },
        here: { flow: "browser", run: "gcloud auth login" },
        away: { flow: "paste", run: "gcloud auth login --no-launch-browser" },
        reads: { url: "(https://accounts\\.google\\.com/\\S+)", prompt: "enter the verification code[^:]*:" },
        signedOut: ["You do not currently have an active account selected", "Reauthentication required", "gcloud auth login"],
    },
    {
        id: "claude",
        name: "Claude Code",
        aliases: ["claude-code"],
        provider: "claude-code",
        status: { run: "claude auth status", signedIn: "\"loggedIn\":\\s*true", who: "\"email\":\\s*\"([^\"]+)\"" },
        here: { flow: "browser", run: "claude auth login" },
        away: { flow: "paste", run: "claude auth login" },
        reads: { url: "(https://\\S+)", prompt: "Paste code here[^>]*>" },
    },
    {
        id: "codex",
        name: "Codex",
        provider: "codex",
        status: { run: "codex login status", signedIn: "^Logged in" },
        here: { flow: "browser", run: "codex login" },
        away: { flow: "device", run: "codex login --device-auth" },
        reads: { code: CODE, url: "(https://auth\\.openai\\.com/\\S+)", expired: "expired" },
    },
];

const WORDS = /^[^\s\0]+(?: [^\s\0]+)*$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

function pattern(v: unknown): boolean {
    if (typeof v !== "string" || !v || v.length > 300) return false;
    try { new RegExp(v); return true; } catch { return false; }
}

/** Why `r` can't be a recipe, or undefined if it can. For the user's own, from settings. */
export function recipeError(r: unknown): string | undefined {
    if (!r || typeof r !== "object" || Array.isArray(r)) return "a sign-in is an object";
    const x = r as Record<string, any>;
    if (typeof x.id !== "string" || !ID.test(x.id)) return "id must be lowercase letters, digits, dots and dashes";
    const command = (v: unknown) => typeof v === "string" && v.length <= 500 && WORDS.test(v);
    const way = (w: any) => w && typeof w === "object" && SIGN_IN_FLOWS.includes(w.flow) && command(w.run) && (w.port === undefined || (Number.isInteger(w.port) && w.port > 0 && w.port < 65536));
    if (typeof x.name !== "string" || !x.name.trim() || x.name.length > 40) return `${x.id}: name is missing`;
    if (!way(x.here)) return `${x.id}: here needs a flow (${SIGN_IN_FLOWS.join(", ")}) and the command to run`;
    if (x.away !== undefined && !way(x.away)) return `${x.id}: away needs a flow and the command to run`;
    if (x.status !== undefined && (!x.status || typeof x.status !== "object" || !command(x.status.run) || (x.status.signedIn !== undefined && !pattern(x.status.signedIn)) || (x.status.who !== undefined && !pattern(x.status.who)))) return `${x.id}: status needs the command to run`;
    if (x.token !== undefined && (!x.token || !command(x.token.run) || (x.token.url !== undefined && !/^https:\/\/\S+$/.test(String(x.token.url))))) return `${x.id}: token needs the command that reads it`;
    if (x.then !== undefined && !command(x.then)) return `${x.id}: then must be a command`;
    for (const k of ["url", "code", "prompt", "expired"]) if (x.reads?.[k] !== undefined && !pattern(x.reads[k])) return `${x.id}: reads.${k} isn't a pattern`;
    if (x.signedOut !== undefined && (!Array.isArray(x.signedOut) || !x.signedOut.every(pattern))) return `${x.id}: signedOut must be patterns`;
    if (x.answers !== undefined && (!Array.isArray(x.answers) || !x.answers.every((a: any) => a && pattern(a.when) && typeof a.send === "string" && a.send.length <= 100))) return `${x.id}: answers need when and send`;
    if (x.env !== undefined && (!x.env || typeof x.env !== "object" || !Object.entries(x.env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === "string"))) return `${x.id}: env must be variables`;
    return undefined;
}

/** A user's recipe as stored, with only the fields a recipe has. Without a status command, the sign-in's own exit says whether it worked. */
function own(r: Record<string, any>): SignInRecipe {
    const way = (w: any): SignInWay => ({ flow: w.flow, run: w.run, ...(w.port ? { port: w.port } : {}) });
    return {
        id: r.id,
        name: r.name.trim(),
        status: r.status ? { run: r.status.run, signedIn: r.status.signedIn, who: r.status.who } : { run: "" },
        here: way(r.here),
        ...(r.away ? { away: way(r.away) } : {}),
        ...(r.token ? { token: { run: r.token.run, url: r.token.url } } : {}),
        ...(r.env ? { env: { ...r.env } } : {}),
        ...(r.reads ? { reads: { url: r.reads.url, code: r.reads.code, prompt: r.reads.prompt, expired: r.reads.expired } } : {}),
        ...(r.answers ? { answers: r.answers.map((a: any) => ({ when: a.when, send: a.send })) } : {}),
        ...(r.then ? { then: r.then } : {}),
        ...(typeof r.warning === "string" && r.warning.trim() ? { warning: r.warning.trim().slice(0, 80) } : {}),
        ...(r.signedOut ? { signedOut: [...r.signedOut] } : {}),
    };
}

/** Cavvy's recipes and the user's own (theirs win, by id). Ones that don't read as a recipe are left out. */
export function signInRecipes(mine: unknown): SignInRecipe[] {
    const out = new Map<string, SignInRecipe>(SIGN_IN_RECIPES.map((r) => [r.id, r]));
    for (const r of Array.isArray(mine) ? mine : []) {
        if (recipeError(r)) continue;
        const built = out.get(r.id);
        // One of the agent CLIs stays tied to it, whatever the user's entry says.
        out.set(r.id, { ...own(r), ...(built?.provider ? { provider: built.provider } : {}) });
    }
    return [...out.values()];
}

/** The recipe an agent means by `target` ("gh", "GitHub", "github"), or undefined. */
export function findRecipe(target: string, recipes: readonly SignInRecipe[]): SignInRecipe | undefined {
    const t = target.trim().toLowerCase();
    return recipes.find((r) => r.id === t) ?? recipes.find((r) => r.name.toLowerCase() === t || r.aliases?.includes(t) || r.provider === t);
}

const matchers = new WeakMap<SignInRecipe, RegExp[]>();

/**
 * The recipe a command's output says is signed out, if any. Only output that failed is looked at, and only its
 * first and last parts: these lines come at an edge.
 */
export function signedOutIn(output: string, recipes: readonly SignInRecipe[]): SignInRecipe | undefined {
    const text = output.length > 8000 ? `${output.slice(0, 4000)}\n${output.slice(-4000)}` : output;
    for (const r of recipes) {
        if (!r.signedOut?.length) continue;
        let res = matchers.get(r);
        if (!res) {
            res = r.signedOut.flatMap((p) => { try { return [new RegExp(p, "i")]; } catch { return []; } });
            matchers.set(r, res);
        }
        if (res.some((re) => re.test(text))) return r;
    }
    return undefined;
}
