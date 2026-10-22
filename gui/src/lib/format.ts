export function ago(ms: number, now = Date.now()): string {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return "now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

export function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** When a prompt was sent, under it: the time today, with the day before that (and the year before this one). */
export function promptTime(ms: number, now = Date.now()): string {
    const d = new Date(ms);
    const today = new Date(now);
    if (d.toDateString() === today.toDateString()) return clock(ms);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}), hour: "numeric", minute: "2-digit" });
}

/** A prompt short enough to be a rounder bubble, like a message: one line of under 60 characters. */
export function shortPrompt(text: string): boolean {
    return text.length < 60 && !text.includes("\n");
}

export { duration, turnDuration } from "../../../src/server/duration";

/** A command that only waits (`sleep 240`, `sleep 4m; echo done`): how long, in seconds. */
export function sleepSeconds(command: unknown): number | undefined {
    if (typeof command !== "string") return undefined;
    const m = /^\s*sleep\s+(\d+(?:\.\d+)?)([smh]?)\s*(?:(?:;|&&)\s*echo(?:\s+[\w .,:!-]*)?)?\s*;?\s*$/.exec(command);
    if (!m) return undefined;
    const s = Number(m[1]) * (m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1);
    return s > 0 ? s : undefined;
}

export function tokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function usd(n: number): string {
    if (n === 0) return "$0";
    if (n < 0.01) return "<$0.01";
    if (n < 10) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(1)}`;
}

/** Spend where some usage may have had no known price: "—" for none priced, "$X+" for part. Never "$0" for unknown. */
export function cost(n: number, unknown?: boolean): string {
    if (!unknown) return usd(n);
    return n > 0 ? `${usd(n)}+` : "—";
}

export function price(p?: { input: number; output: number }): string {
    if (!p) return "";
    const f = (x: number) => (x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(2).replace(/\.?0+$/, "") : x.toFixed(2));
    return `$${f(p.input)} / $${f(p.output)}`;
}

export function basename(p: string): string {
    return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
}

/** "~/code/app" for a path under the home folder. */
export function tildify(p: string, home?: string): string {
    if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
    return p;
}

export function plural(n: number, word: string, many = `${word}s`): string {
    return `${n} ${n === 1 ? word : many}`;
}

/** "Read(src/a.ts)" -> { verb: "Read", arg: "src/a.ts" } */
export function splitTitle(title: string): { verb: string; arg?: string } {
    const m = title.match(/^([\w .-]+?)\((.*)\)$/s);
    if (m) return { verb: m[1]!, arg: m[2] };
    return { verb: title };
}

export function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

export function dayGroup(ms: number, now = new Date()): string {
    const d = new Date(ms);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= start) return "Today";
    if (ms >= start - 86400_000) return "Yesterday";
    if (ms >= start - 6 * 86400_000) return "Previous 7 days";
    if (ms >= start - 29 * 86400_000) return "Previous 30 days";
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function langOf(path: string): string | undefined {
    const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const name = basename(path).toLowerCase();
    if (name === "dockerfile") return "dockerfile";
    if (name === "makefile") return "make";
    const map: Record<string, string> = {
        ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript", json: "json", jsonc: "jsonc",
        md: "markdown", mdx: "mdx", py: "python", rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
        c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "shellscript", bash: "shellscript", zsh: "shellscript",
        yml: "yaml", yaml: "yaml", toml: "toml", html: "html", css: "css", scss: "scss", sql: "sql", vue: "vue", svelte: "svelte",
        lua: "lua", ex: "elixir", exs: "elixir", zig: "zig", dart: "dart", scala: "scala", graphql: "graphql", proto: "proto", xml: "xml",
        ini: "ini", tf: "hcl", nix: "nix", r: "r", jl: "julia", hs: "haskell", ml: "ocaml", clj: "clojure", erl: "erlang",
    };
    return ext ? map[ext] : undefined;
}

/** "now", "5m", "3h", "2d", "1w", "4mo", "2y": for narrow places like the sidebar. */
export function since(ms: number, now = Date.now()): string {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return "now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    const d = Math.floor(s / 86400);
    if (d < 7) return `${d}d`;
    if (d < 35) return `${Math.floor(d / 7)}w`;
    if (d < 365) return `${Math.max(1, Math.floor(d / 30))}mo`;
    return `${Math.floor(d / 365)}y`;
}

/** Two letters for a project: "my-own-harness" -> "MH", "api" -> "AP". */
export function monogram(name: string): string {
    const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return "?";
    const s = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : words[0]!.slice(0, 2);
    return s.toUpperCase();
}

/**
 * Where a diff's first change is in the new file: the line of the first added
 * or removed line (a removal, where its text was). A hunk starts with up to
 * three lines of context, so its newStart is above the change.
 */
export function firstChangedLine(diff?: { hunks?: { newStart: number; lines: { t: string; b?: number }[] }[] }): number | undefined {
    for (const h of diff?.hunks ?? []) {
        let next = h.newStart;
        for (const l of h.lines) {
            if (l.t !== "ctx") return Math.max(1, l.t === "add" ? (l.b ?? next) : next);
            next = (l.b ?? next) + 1;
        }
    }
    return undefined;
}

/** Resolve duplicate initials by adding word initials, then a stable path suffix. */
export function projectMonograms(projects: readonly { cwd: string; projectName: string }[]): Map<string, string> {
    const unique = [...new Map(projects.map((p) => [p.cwd, p])).values()].sort((a, b) => a.cwd.localeCompare(b.cwd));
    const result = new Map<string, string>();
    const used = new Set<string>();
    const counts = new Map<string, number>();
    for (const p of unique) counts.set(monogram(p.projectName), (counts.get(monogram(p.projectName)) ?? 0) + 1);
    for (const p of unique) {
        const base = monogram(p.projectName);
        const words = p.projectName.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
        let label = base;
        if (counts.get(base)! > 1) label = words.length > 2 ? words.map((w) => w[0]).join("").slice(0, 3) : (words.join("").slice(0, 3) || base);
        const candidate = label;
        let suffix = 2;
        while (used.has(label)) label = `${candidate}${suffix++}`;
        used.add(label);
        result.set(p.cwd, label);
    }
    return result;
}

/** Dark, saturated backgrounds keep white initials readable in every theme. */
const PROJECT_COLORS = ["#844237", "#745316", "#336744", "#236773", "#405c9b", "#70499a", "#91436d", "#515c6c"];
export function projectColor(identity: string): string {
    let hash = 0;
    for (const c of identity) hash = (Math.imul(hash, 31) + c.codePointAt(0)!) | 0;
    return PROJECT_COLORS[(hash >>> 0) % PROJECT_COLORS.length]!;
}
