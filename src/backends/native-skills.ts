// The harness's skills, handed to Claude Code and Codex so each runs them its
// own way (its Skill tool, its /name, its skill items) instead of the harness
// pasting SKILL.md into the prompt.
//
// Both CLIs get a generated folder, <harness home>/cache/cli-skills/<hash>/:
//   .claude-plugin/plugin.json   Claude Code's only: it loads the folder with --plugin-dir, and its skills
//                                are harness:<name> there (Codex would name them so too, so its folder has none)
//   skills/<name>                a link to the skill's folder, or, when its SKILL.md uses
//                                ${HARNESS_SKILL_DIR} (which neither CLI fills in), a folder with that
//                                filled in and links to everything else
// Codex gets skills/ as an extra skills root (skills/extraRoots/set).

import { createHash } from "crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { harnessHome } from "../config/paths";
import { formatSkill, mentionNames, skillMentions, withSkills, type Skill } from "../agent/skills";

/** Claude Code names a plugin's skills <plugin>:<name>. */
export const CLAUDE_PLUGIN = "harness";
export const CLAUDE_PREFIX = `${CLAUDE_PLUGIN}:`;

/** Claude Code and Codex run skills themselves; the harness's API models get them pasted in. */
export function cliRunsSkills(provider: string | undefined): boolean {
    return provider === "claude-code" || provider === "codex";
}

const DIR_VAR = /\$\{(HARNESS|CLAUDE)_SKILL_DIR\}/g;
/** Folders are removed after this long unused (another process may be using one: a day is far longer than a turn). */
const STALE_MS = 24 * 60 * 60 * 1000;
const built = new Map<string, string>();

/** The folder holding `skills`, built once per set of skills (and their SKILL.md versions); `plugin`: Claude Code's, a plugin. */
export function skillFolder(skills: readonly Skill[], opts: { plugin?: boolean } = {}): string | undefined {
    if (!skills.length) return undefined;
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    const hash = createHash("sha256");
    hash.update(opts.plugin ? "plugin\0" : "skills\0");
    // The folder's time too: a file added beside a SKILL.md that's copied (below) needs linking.
    for (const s of sorted) hash.update(`${s.name}\0${s.dir}\0${mtime(s.file)}\0${mtime(s.dir)}\0${copiedTimes(s)}\0`);
    const key = hash.digest("hex").slice(0, 16);
    const base = join(harnessHome(), "cache", "cli-skills");
    const dir = join(base, key);
    const cached = built.get(key);
    if (cached && existsSync(cached)) return touch(cached);
    if (!existsSync(join(dir, "skills"))) {
        const tmp = `${dir}.${process.pid}.${Math.random().toString(36).slice(2)}`;
        try {
            mkdirSync(join(tmp, "skills"), { recursive: true });
            if (opts.plugin) {
                mkdirSync(join(tmp, ".claude-plugin"));
                writeFileSync(join(tmp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: CLAUDE_PLUGIN, description: "Skills from Harness (~/.harness/skills and the project's .harness/skills)" }, null, 2));
            }
            for (const s of sorted) addSkill(skillFile(tmp, s, ""), s);
            renameSync(tmp, dir);
        } catch {
            // Another process built it first (rename onto a full folder fails), or the cache can't be written.
            remove(tmp);
            if (!existsSync(join(dir, "skills"))) return undefined;
        }
        prune(base, key);
    }
    built.set(key, dir);
    return touch(dir);
}

/** On Windows, a skill's files beside a filled-in SKILL.md are copies (see link): their times, so an edit is copied again. */
function copiedTimes(s: Skill): string {
    if (process.platform !== "win32") return "";
    try {
        return readdirSync(s.dir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name !== "SKILL.md")
            .map((e) => `${e.name}:${mtime(join(s.dir, e.name))}`)
            .join(",");
    } catch {
        return "";
    }
}

/** Marks a folder used (prune goes by this), at most once a minute. */
function touch(dir: string): string {
    const now = Date.now();
    if (now - (touched.get(dir) ?? 0) > 60_000) {
        touched.set(dir, now);
        try {
            utimesSync(dir, new Date(now), new Date(now));
        } catch {}
    }
    return dir;
}
const touched = new Map<string, number>();

/** Where `s` is in the folder `dir` (its SKILL.md, or with `file` "" its folder). */
export function skillFile(dir: string, s: Skill, file = "SKILL.md"): string {
    return join(dir, "skills", folderName(s), file);
}

/** A name with a colon (a plugin's <plugin>:<name>) can't be a folder's name everywhere; Claude Code names a plugin's skills by folder. */
function folderName(s: Skill): string {
    return s.name.replace(/:/g, "__");
}

function addSkill(at: string, s: Skill) {
    let text: string | undefined;
    try {
        text = readFileSync(s.file, "utf8");
    } catch {
        return;
    }
    if (!DIR_VAR.test(text)) return link(s.dir, at);
    DIR_VAR.lastIndex = 0;
    mkdirSync(at);
    writeFileSync(join(at, "SKILL.md"), text.replace(DIR_VAR, () => s.dir));
    for (const entry of readdirSync(s.dir)) if (entry !== "SKILL.md") link(join(s.dir, entry), join(at, entry));
}

function link(target: string, at: string) {
    if (process.platform !== "win32") return symlinkSync(target, at);
    // On Windows a link to a file needs rights a user may not have; a junction (to a folder) doesn't.
    if (isDir(target)) symlinkSync(target, at, "junction");
    else copyFileSync(target, at);
}

function prune(base: string, keep: string) {
    try {
        for (const name of readdirSync(base)) {
            if (name === keep) continue;
            const p = join(base, name);
            if (Date.now() - statSync(p).mtimeMs > STALE_MS) remove(p);
        }
    } catch {}
}

/** Removes a built folder: its links first, so nothing they point to (the user's skills) can be reached. */
function remove(p: string) {
    try {
        for (const name of readdirSync(join(p, "skills"))) {
            const at = join(p, "skills", name);
            if (lstatSync(at).isSymbolicLink()) unlinkSync(at);
            else for (const entry of readdirSync(at)) if (lstatSync(join(at, entry)).isSymbolicLink()) unlinkSync(join(at, entry));
        }
    } catch {}
    rmSync(p, { recursive: true, force: true });
}

function mtime(file: string): number {
    try {
        return statSync(file).mtimeMs;
    } catch {
        return 0;
    }
}

function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * How Claude Code runs each of `skills`: the name it knows the skill by. Those
 * in its config folder's skills or, trusted, the project's .claude/skills it
 * reads itself; `plugged` (in the harness's plugin) are harness:<name>. The
 * rest (a plugin's, until its folder is passed to Claude Code) aren't there.
 */
export function claudeNames(skills: readonly Skill[], plugged: readonly Skill[], cwd: string, trusted: boolean, configDir?: string): Map<string, string> {
    const own = claudeRoots(cwd, trusted, configDir);
    const names = new Map(skills.filter((s) => s.source !== "plugin" && readsItself(s, own)).map((s) => [s.name, s.name]));
    for (const s of plugged) names.set(s.name, CLAUDE_PREFIX + folderName(s));
    return names;
}

/**
 * The skills to put in Claude Code's plugin: not those it reads itself, not a
 * plugin's (they'd be harness:<plugin>__<name>), and a project's only when the
 * user trusts it.
 */
export function forClaudeCode(skills: readonly Skill[], cwd: string, trusted: boolean, configDir?: string): Skill[] {
    const own = claudeRoots(cwd, trusted, configDir);
    return skills.filter((s) => s.source !== "plugin" && (trusted || s.source !== "project") && !readsItself(s, own));
}

/**
 * In one of Claude Code's own skills folders, or linked into one under its name: a
 * Harness-made account's skills folder links Default's skills (account-layout.ts).
 */
function readsItself(s: Skill, own: ReadonlySet<string>): boolean {
    if (own.has(resolve(dirname(s.dir)))) return true;
    for (const root of own) {
        const entry = join(root, basename(s.dir));
        try {
            if (lstatSync(entry).isSymbolicLink() && realpathSync(entry) === realpathSync(s.dir)) return true;
        } catch {
            // not there
        }
    }
    return false;
}

function claudeRoots(cwd: string, trusted: boolean, configDir?: string): Set<string> {
    return new Set([resolve(configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"), ...(trusted ? [resolve(cwd, ".claude", "skills")] : [])]);
}

/**
 * The prompt for Claude Code. `/name args` at the start of the user's message
 * runs the skill by the name Claude Code knows it by (`names`); a $name mention
 * asks it to load the skill with its Skill tool. Where it can't run one (it
 * doesn't have it, the message isn't at the start of the prompt, or the model
 * may not load it), the skill's text goes in the prompt, as for the harness's models.
 */
export function claudePrompt(prompt: string, request: string | undefined, skills: readonly Skill[], names: ReadonlyMap<string, string>, format: (s: Skill, args: string) => string | undefined, after = ""): string {
    const head = headOf(prompt, request, after);
    if (head === undefined) return prompt;
    const { named, args } = slashSkill(request!, skills);
    let text = request!;
    if (named) {
        const name = runnable(named, names);
        // Run as a command only as the whole prompt: what comes after it would be the skill's arguments.
        text = name && !head && !after ? `/${name}${args ? ` ${args}` : ""}` : (format(named, args) ?? request!);
    }
    // $names after a /name too (its arguments).
    const notes = skillMentions(named ? args : request!, skills)
        .filter((s) => s !== named)
        .map((s) => {
            const name = runnable(s, names);
            return name && s.modelInvocable ? `Load the "${name}" skill with the Skill tool and follow it.` : format(s, "");
        })
        .filter(Boolean);
    if (!named && !notes.length) return prompt;
    return head + text + after + (notes.length ? `\n\n${notes.join("\n\n")}` : "");
}

/** The prompt before the user's message, if it is `head + request + after`. */
function headOf(prompt: string, request: string | undefined, after: string): string | undefined {
    if (!request || !prompt.endsWith(request + after)) return undefined;
    return prompt.slice(0, prompt.length - request.length - after.length);
}

/** The skill a `/name args` message runs, and its arguments. */
function slashSkill(request: string, skills: readonly Skill[]): { named?: Skill; args: string } {
    const slash = request.match(/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i);
    const named = slash ? skills.find((s) => s.userInvocable && s.name === slash[1]!.toLowerCase()) : undefined;
    return { named, args: named ? (slash![2] ?? "").trim() : "" };
}

/**
 * The name Claude Code runs `s` by, if it runs it as the harness would: one
 * in its own folders that uses ${HARNESS_SKILL_DIR}, which Claude Code doesn't
 * fill in (it does ${CLAUDE_SKILL_DIR}), is pasted in instead.
 */
function runnable(s: Skill, names: ReadonlyMap<string, string>): string | undefined {
    const name = names.get(s.name);
    if (name !== s.name) return name;
    try {
        return /\$\{HARNESS_SKILL_DIR\}/.test(readFileSync(s.file, "utf8")) ? undefined : name;
    } catch {
        return name;
    }
}

/** A skill Codex has (skills/list): the item that runs it is { type: "skill", name, path }. */
export interface CodexSkill {
    name: string;
    path: string;
    description?: string;
    enabled?: boolean;
    /** Codex's name for it, when this is the harness's name for one of its skills. */
    codexName?: string;
    /** The harness's skill it is (the harness's name for it). */
    harness?: string;
}

/**
 * Codex's input for the user's message: `/name args` at its start becomes
 * `$name args`, Codex's own way of naming a skill, and each skill named so (or
 * by a $name mention) is sent as a skill item, which has Codex load it. One
 * of the harness's (`harness`) that Codex didn't list goes in as text.
 */
export function codexInput(prompt: string, request: string | undefined, skills: readonly CodexSkill[], harness: readonly Skill[] = [], after = ""): { text: string; items: { type: "skill"; name: string; path: string }[] } {
    const head = headOf(prompt, request, after);
    if (head === undefined) return { text: prompt, items: [] };
    // A name the harness has is the harness's skill, as in its menus, even where Codex has one of its own by that name;
    // and one the user can't run (user-invocable: false) isn't a skill to run.
    const ours = new Map(harness.map((s) => [s.name, s]));
    const byName = new Map<string, CodexSkill>();
    for (const s of skills) if (s.enabled !== false && !s.harness && !ours.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s);
    for (const s of skills) if (s.enabled !== false && s.harness && ours.get(s.harness)?.userInvocable) byName.set(s.harness, s);
    const missing = harness.filter((s) => s.userInvocable && !byName.has(s.name));
    let text = request!;
    // Where $names are looked for: the message, or a pasted /name's arguments.
    let scan = text;
    const slash = text.match(/^\/([a-z0-9][a-z0-9:_-]*)(?=\s|$)/i);
    const key = slash?.[1]!.toLowerCase();
    const pasted = key && !byName.has(key) ? slashSkill(text, missing) : { args: "" };
    // By the name as listed: Codex reads $DEPLOY as text, not a skill.
    if (key && byName.has(key)) scan = text = `$${key}${text.slice(slash![0].length)}`;
    else if (pasted.named) {
        text = formatSkill(pasted.named, pasted.args) ?? text;
        scan = pasted.args;
    }
    const items: { type: "skill"; name: string; path: string }[] = [];
    for (const name of mentionNames(scan)) {
        const s = byName.get(name);
        if (s && !items.some((i) => i.path === s.path)) items.push({ type: "skill", name: s.codexName ?? s.name, path: s.path });
    }
    const mentioned = skillMentions(scan, missing).filter((s) => s !== pasted.named);
    return { text: head + (mentioned.length ? withSkills(text + after, mentioned) : text + after), items };
}

/**
 * Codex's skills (skills/list) as the harness names them: one of the
 * harness's goes by its harness name (a plugin's is <plugin>:<name>) as well
 * as Codex's; `own` are those that aren't the harness's, for its menus (not
 * one whose name the harness has, which is the harness's there).
 */
export function codexSkills(listed: readonly CodexSkill[], harness: readonly Skill[], folder: string | undefined): { skills: CodexSkill[]; own: string[] } {
    // Codex reports each by its real path: the skill's own SKILL.md through a link, or the folder's copy.
    const byFile = new Map(folder ? harness.map((s) => [real(skillFile(folder, s)), s]) : []);
    const skills: CodexSkill[] = [];
    const own: string[] = [];
    const names = new Set(harness.map((s) => s.name));
    for (const c of listed) {
        if (c.enabled === false) continue;
        const ours = byFile.get(real(c.path));
        skills.push(ours ? { ...c, name: ours.name, codexName: c.name, harness: ours.name } : c);
        if (!ours && !names.has(c.name.toLowerCase())) own.push(c.name);
    }
    return { skills, own };
}

function real(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return resolve(p);
    }
}

/** Where the CLI can't take them itself (an older Codex): the skills /name and $name ask for, pasted in as for the harness's models. */
export function pastedPrompt(prompt: string, request: string | undefined, skills: readonly Skill[], after = ""): string {
    const head = headOf(prompt, request, after);
    if (head === undefined || !skills.length) return prompt;
    const { named, args } = slashSkill(request!, skills);
    const text = named ? (formatSkill(named, args) ?? request!) : request!;
    const mentioned = skillMentions(named ? args : request!, skills).filter((s) => s !== named);
    if (!named && !mentioned.length) return prompt;
    return head + (mentioned.length ? withSkills(text + after, mentioned) : text + after);
}
