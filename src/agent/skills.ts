// Skills: folders with a SKILL.md the model can load on its own (the Skill
// tool) and the user can run as /name or mention as $name. Read from, lowest
// to highest precedence:
//   ~/.claude/skills/<name>/SKILL.md          (Claude Code's, so they work with every model)
//   ~/.cavvy/skills/<name>/SKILL.md
//   <project>/.claude/skills/<name>/SKILL.md  (trusted folders only)
//   <project>/.cavvy/skills/<name>/SKILL.md (trusted folders only)
//   plugin skill folders, as <plugin>:<name>
//
//   ---
//   name: pdf                          (optional; default: the folder's name)
//   description: Fill in and read PDF forms
//   when_to_use: The user mentions a PDF   (optional; shown to the model)
//   argument-hint: [file]              (optional)
//   disable-model-invocation: true     (optional; only the user runs it)
//   user-invocable: false              (optional; only the model loads it)
//   ---
//   Instructions... $ARGUMENTS, $1..$9 and ${CAVVY_SKILL_DIR} are substituted.

import { closeSync, openSync, readdirSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { cavvyHome, paths } from "../config/paths";
import { expandCommand } from "../commands/custom";
import { loadPlugins } from "../plugins/loader";
import { withoutReviewQuotes } from "../util/review-quotes";

export interface Skill {
    name: string;
    description: string;
    whenToUse?: string;
    argumentHint?: string;
    /** Listed to the model, which can load it with the Skill tool. */
    modelInvocable: boolean;
    /** Runs as /name and shows in the / and $ menus. */
    userInvocable: boolean;
    source: "user" | "project" | "plugin";
    /** The SKILL.md. */
    file: string;
    /** Its folder: scripts and references next to it resolve against this. */
    dir: string;
    /** In one of Claude Code's skill folders, or a plugin's (Claude Code loads plugins itself: src/plugins/native.ts), so Claude Code runs it itself. */
    claudeCode?: boolean;
}

/** A folder whose children are <skill>/SKILL.md (or, `single`, one skill's own folder); plugins name theirs <namespace>:<skill>. */
export interface SkillRoot {
    dir: string;
    single?: boolean;
    source: Skill["source"];
    namespace?: string;
    claudeCode?: boolean;
}

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_BYTES = 256_000;
const MAX_SKILLS_PER_ROOT = 500;
const HEAD_BYTES = 8192;
const NAME = /^[a-z0-9][a-z0-9:_-]*$/;

/** The folders skills are read from, lowest precedence first. */
export function skillRoots(cwd: string, trusted: boolean): SkillRoot[] {
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const roots: SkillRoot[] = [
        { dir: join(claudeHome, "skills"), source: "user", claudeCode: true },
        { dir: join(cavvyHome(), "skills"), source: "user" },
    ];
    // A repository's skills are instructions from whoever wrote it.
    if (trusted) roots.push({ dir: join(cwd, ".claude", "skills"), source: "project", claudeCode: true }, { dir: paths.projectSkills(cwd), source: "project" });
    return roots;
}

/** Skill folders installed plugins bring (see the plugins loader). */
export type ExtraSkillRoot = { dir: string; namespace: string; single?: boolean };

export function pluginSkillRoots(cwd: string, trusted: boolean): ExtraSkillRoot[] {
    return loadPlugins(cwd, trusted).flatMap((p) => [...p.skillDirs.map((dir) => ({ dir, namespace: p.name })), ...p.skillFolders.map((dir) => ({ dir, namespace: p.name, single: true }))]);
}

export function loadSkills(cwd: string, trusted: boolean, extra: ExtraSkillRoot[] = pluginSkillRoots(cwd, trusted)): Skill[] {
    const byName = new Map<string, Skill>();
    const roots: SkillRoot[] = [...skillRoots(cwd, trusted), ...extra.map((r) => ({ dir: r.dir, source: "plugin" as const, namespace: r.namespace, single: r.single, claudeCode: true }))];
    for (const root of roots) for (const s of scanRoot(root)) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `next`, or `prev` when nothing about the skills changed, so what was built from `prev` (the Skill tool) is kept. */
export function sameSkills(prev: Skill[], next: Skill[]): Skill[] {
    return prev.length === next.length && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function findSkill(name: string, cwd: string, trusted: boolean): Skill | undefined {
    return loadSkills(cwd, trusted).find((s) => s.name === name.toLowerCase());
}

function scanRoot(root: SkillRoot): Skill[] {
    if (root.single) {
        const file = join(root.dir, SKILL_FILE);
        const text = readSkillFile(file, HEAD_BYTES);
        const skill = text === undefined ? undefined : parseSkill(text, basename(root.dir), file, root);
        return skill ? [skill] : [];
    }
    let entries;
    try {
        entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: Skill[] = [];
    for (const e of entries) {
        if (out.length >= MAX_SKILLS_PER_ROOT) break;
        if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
        const file = join(root.dir, e.name, SKILL_FILE);
        // The listing needs the frontmatter and the first line; the body is read when the skill is used.
        const text = readSkillFile(file, HEAD_BYTES);
        if (text === undefined) continue;
        const skill = parseSkill(text, e.name, file, root);
        if (skill) out.push(skill);
    }
    return out;
}

/** A SKILL.md's text (its first `limit` bytes when that holds the frontmatter and some body), or undefined when it's missing, not a file, or too big. */
function readSkillFile(file: string, limit = Infinity): string | undefined {
    let fd: number | undefined;
    try {
        const st = statSync(file);
        if (!st.isFile() || st.size > MAX_SKILL_BYTES) return undefined;
        const f = (fd = openSync(file, "r"));
        const read = (size: number) => {
            const buf = Buffer.alloc(size);
            return buf.subarray(0, readSync(f, buf, 0, size, 0)).toString("utf-8").replace(/^\uFEFF/, "");
        };
        if (st.size <= limit) return read(st.size);
        const head = read(limit);
        // Cut inside the frontmatter (or before any body): it needs the rest.
        return /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n[\s\S]*\S/.test(head) ? head : read(st.size);
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

export function parseSkill(text: string, folder: string, file: string, root: Pick<SkillRoot, "source" | "namespace" | "claudeCode">): Skill | undefined {
    const { data, body } = parseSkillFrontmatter(text);
    const own = (data.name || folder).toLowerCase().trim();
    const base = NAME.test(own) && !own.includes(":") ? own : folder.toLowerCase();
    const name = root.namespace ? `${root.namespace.toLowerCase()}:${base}` : base;
    if (!NAME.test(name)) return undefined;
    const firstLine = body.trim().split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
    return {
        name,
        description: oneLine(data.description || firstLine || name),
        whenToUse: data.when_to_use ? oneLine(data.when_to_use) : undefined,
        argumentHint: data["argument-hint"] || undefined,
        modelInvocable: !isTrue(data["disable-model-invocation"]),
        userInvocable: !isFalse(data["user-invocable"]),
        source: root.source,
        file,
        dir: dirname(file),
        ...(root.claudeCode ? { claudeCode: true } : {}),
    };
}

const isTrue = (v?: string) => /^(true|yes|on)$/i.test(v ?? "");
const isFalse = (v?: string) => /^(false|no|off)$/i.test(v ?? "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * SKILL.md frontmatter: `key: value` lines, plus the YAML Claude Code's skills
 * use for long values: block scalars (`description: >` or `|`), indented
 * continuation lines, and `- item` lists (joined with ", ").
 */
export function parseSkillFrontmatter(text: string): { data: Record<string, string>; body: string } {
    const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
    if (!m) return { data: {}, body: text };
    const data: Record<string, string> = {};
    const lines = m[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = lines[i]!.match(/^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/);
        if (!kv) continue;
        const key = kv[1]!.toLowerCase();
        let value = (kv[2] ?? "").trim();
        // A comment, unless it's inside a quoted value ("Fix issue #12").
        const quoted = value.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#.*)?$/);
        value = quoted ? quoted[1]! : value.replace(/\s+#.*$/, "");
        const more: string[] = [];
        while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (!lines[i + 1]!.trim() && /^[|>]/.test(value)))) more.push(lines[++i]!);
        if (/^[|>][-+]?$/.test(value)) {
            const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
            const block = more.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
            value = (value.startsWith("|") ? block.join("\n") : block.map((l) => l.trim()).join(" ")).trim();
        } else if (!value && more.every((l) => /^\s*-\s/.test(l) || !l.trim())) {
            value = more.map((l) => unquote(l.replace(/^\s*-\s+/, "").trim())).filter(Boolean).join(", ");
        } else {
            value = [value, ...more.map((l) => l.trim())].filter(Boolean).join(" ");
        }
        data[key] = unquote(value);
    }
    return { data, body: m[2]! };
}

function unquote(s: string): string {
    const q = s.match(/^(["'])([\s\S]*)\1$/);
    return q ? (q[1] === '"' ? q[2]!.replace(/\\"/g, '"') : q[2]!.replace(/''/g, "'")) : s;
}

/** The skill's instructions, read again (it may have changed since it was listed); undefined when it's gone. */
export function skillBody(skill: Skill): string | undefined {
    const text = readSkillFile(skill.file);
    return text === undefined ? undefined : parseSkillFrontmatter(text).body.trim();
}

/**
 * The skill as the model gets it: its folder (relative paths resolve there)
 * and its instructions, with the arguments substituted.
 */
export function formatSkill(skill: Skill, args = ""): string | undefined {
    const body = skillBody(skill);
    if (body === undefined) return undefined;
    const withDir = body.replace(/\$\{(?:CAVVY|CLAUDE|HARNESS)_SKILL_DIR\}/g, () => skill.dir);
    // Without arguments the body is left as written: `awk '{print $1}'` in a skill is a shell snippet.
    const text = args ? expandCommand(withDir, args) : withDir;
    return `<skill name="${skill.name}">\nBase directory for this skill: ${skill.dir}\n\n${text.trim()}\n</skill>`;
}

/**
 * The skills a prompt mentions as $name (T3 Code's syntax), in order and once
 * each. Prices ($5, $10k) and names no skill has ($HOME) stay plain text.
 */
export function skillMentions(text: string, skills: readonly Skill[]): Skill[] {
    if (!text.includes("$") || !skills.length) return [];
    const byName = new Map(skills.filter((s) => s.userInvocable).map((s) => [s.name, s]));
    const out = new Map<string, Skill>();
    for (const name of mentionNames(text)) {
        const s = byName.get(name);
        if (s) out.set(s.name, s);
    }
    return [...out.values()];
}

/** The names `text` mentions as $name, lowercased, in order. */
export function mentionNames(text: string): string[] {
    const out: string[] = [];
    for (const m of withoutReviewQuotes(text).matchAll(/(^|[\s(])\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=[\s.,;:!?)]|$)/g)) {
        const raw = m[2]!.replace(/:+$/, "");
        // $HOME and $5 are a shell variable and a price.
        if (/[a-z]/.test(raw)) out.push(raw.toLowerCase());
    }
    return out;
}

/** The prompt with the instructions of `mentioned` (its $mentions) after it, for the model; `text` itself is what the transcript shows. */
export function withSkills(text: string, mentioned: readonly Skill[]): string {
    const blocks = mentioned.flatMap((s) => formatSkill(s) ?? []);
    return blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text;
}

