// Skills: the SKILL.md loader, the Skill tool, $name mentions, and running
// one as /name in the TUI.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { loadSkills, parseSkillFrontmatter, formatSkill, skillMentions, withSkills, skillBody, findSkill } = await import("../src/agent/skills");
const { skillTool, skillListing } = await import("../src/tools/skill-tool");
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { runCommand, commandList } = await import("../src/commands/index");
const { stripAnsi } = await import("../src/ui/ansi");
import type { Skill } from "../src/agent/skills";

const userSkills = join(iso.home, "skills");
const claudeSkills = join(process.env.CLAUDE_CONFIG_DIR!, "skills");
afterAll(() => iso.cleanup());
beforeEach(() => {
    rmSync(userSkills, { recursive: true, force: true });
    rmSync(claudeSkills, { recursive: true, force: true });
});

function write(file: string, text: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
}
const skill = (root: string, name: string, front: string, body = "Do the thing.") => write(join(root, name, "SKILL.md"), front ? `---\n${front}\n---\n${body}\n` : `${body}\n`);
const project = () => tempDir("harness-skills-proj-");
const ctx = { signal: new AbortController().signal } as any;

describe("loading skills", () => {
    test("user skills, Claude Code's, and the project's only when trusted; the more specific one wins", () => {
        const cwd = project();
        skill(claudeSkills, "pdf", "description: Claude's pdf");
        skill(claudeSkills, "only-claude", "description: From Claude Code");
        skill(userSkills, "pdf", "description: Harness pdf");
        skill(join(cwd, ".claude", "skills"), "deploy", "description: Project deploy (claude)");
        skill(join(cwd, ".harness", "skills"), "deploy", "description: Project deploy (harness)");
        skill(join(cwd, ".harness", "skills"), "pdf", "description: Project pdf");

        const untrusted = loadSkills(cwd, false);
        expect(untrusted.map((s) => `${s.name}:${s.source}:${s.description}`)).toEqual(["only-claude:user:From Claude Code", "pdf:user:Harness pdf"]);
        const trusted = loadSkills(cwd, true);
        expect(trusted.map((s) => `${s.name}:${s.source}:${s.description}`)).toEqual(["deploy:project:Project deploy (harness)", "only-claude:user:From Claude Code", "pdf:project:Project pdf"]);
        expect(trusted.find((s) => s.name === "pdf")!.dir).toBe(join(cwd, ".harness", "skills", "pdf"));
        expect(findSkill("PDF", cwd, true)?.source).toBe("project");
    });

    test("a plugin can name one skill's own folder", () => {
        const plugin = tempDir("harness-skills-plugin-");
        skill(plugin, "local-ai-use", "description: One skill");
        const all = loadSkills(project(), false, [{ dir: join(plugin, "local-ai-use"), namespace: "acme", single: true }]);
        expect(all.map((s) => `${s.name}:${s.source}`)).toEqual(["acme:local-ai-use:plugin"]);
    });

    test("plugin folders are namespaced and override nothing of the user's", () => {
        const cwd = project();
        const plugin = tempDir("harness-skills-plugin-");
        skill(plugin, "review", "description: Plugin review");
        skill(userSkills, "review", "description: Mine");
        const all = loadSkills(cwd, true, [{ dir: plugin, namespace: "Acme" }]);
        expect(all.map((s) => `${s.name}:${s.source}`)).toEqual(["acme:review:plugin", "review:user"]);
    });

    test("frontmatter: the name, invocation flags, argument hint and when_to_use", () => {
        skill(userSkills, "Folder-Name", "name: shown-name\ndescription: \"Quoted: with a colon\"\nwhen_to_use: When asked\nargument-hint: [file]\ndisable-model-invocation: true");
        skill(userSkills, "model-only", "description: Background knowledge\nuser-invocable: false");
        const [model, shown] = loadSkills(project(), false);
        expect(shown).toMatchObject({ name: "shown-name", description: "Quoted: with a colon", whenToUse: "When asked", argumentHint: "[file]", modelInvocable: false, userInvocable: true });
        expect(model).toMatchObject({ name: "model-only", modelInvocable: true, userInvocable: false });
    });

    test("without frontmatter, the folder names it and its first line describes it", () => {
        skill(userSkills, "notes", "", "# Taking notes\n\nWrite them down.");
        expect(loadSkills(project(), false)[0]).toMatchObject({ name: "notes", description: "Taking notes" });
    });

    test("what isn't a skill is skipped, without failing the rest", () => {
        skill(userSkills, "good", "description: Fine");
        skill(userSkills, "bad name!", "description: Not a command name");
        skill(userSkills, ".hidden", "description: Hidden folder");
        mkdirSync(join(userSkills, "empty-folder"), { recursive: true });
        mkdirSync(join(userSkills, "dir-not-file", "SKILL.md"), { recursive: true });
        write(join(userSkills, "huge", "SKILL.md"), `---\ndescription: Too big\n---\n${"x".repeat(300_000)}`);
        write(join(userSkills, "loose-file.md"), "not in a folder");
        // A link to another skill folder works; a link loop doesn't hang or throw.
        skill(tempDir("harness-skills-linked-"), "linked", "description: Through a link");
        symlinkSync(join(dirname(join(userSkills, "x")), "..", "nowhere"), join(userSkills, "dangling"));
        mkdirSync(join(userSkills, "loop"));
        symlinkSync(join(userSkills, "loop"), join(userSkills, "loop", "SKILL.md"));
        expect(loadSkills(project(), false).map((s) => s.name)).toEqual(["good"]);
    });

    test("a linked skill folder loads", () => {
        const elsewhere = tempDir("harness-skills-linked-");
        skill(elsewhere, "linked", "description: Through a link");
        mkdirSync(userSkills, { recursive: true });
        symlinkSync(join(elsewhere, "linked"), join(userSkills, "linked"));
        expect(loadSkills(project(), false).map((s) => s.name)).toEqual(["linked"]);
    });

    test("CRLF line endings and a byte-order mark", () => {
        write(join(userSkills, "win", "SKILL.md"), "﻿---\r\ndescription: Windows file\r\n---\r\nBody line\r\n");
        const [s] = loadSkills(project(), false);
        expect(s!.description).toBe("Windows file");
        expect(skillBody(s!)).toBe("Body line");
    });

    test("a long SKILL.md is listed from its start, and used whole", () => {
        skill(userSkills, "long", "description: Long one", `First line.\n${"more ".repeat(5000)}\nLAST LINE`);
        write(join(userSkills, "long-front", "SKILL.md"), `---\ndescription: Front matter that runs past the first read\nnotes: ${"n".repeat(10_000)}\n---\nBody.`);
        const [long, front] = loadSkills(project(), false);
        expect(long!.description).toBe("Long one");
        expect(formatSkill(long!)).toContain("LAST LINE");
        expect(front!.description).toBe("Front matter that runs past the first read");
    });

    test("read again unchanged, the same list comes back, so the Skill tool built from it is kept", async () => {
        const { sameSkills } = await import("../src/agent/skills");
        skill(userSkills, "a", "description: A");
        const first = loadSkills(project(), false);
        expect(sameSkills(first, loadSkills(project(), false))).toBe(first);
        skill(userSkills, "a", "description: Changed");
        expect(sameSkills(first, loadSkills(project(), false))[0]!.description).toBe("Changed");
    });

    test("200 skills load quickly", () => {
        for (let i = 0; i < 200; i++) skill(userSkills, `skill-${i}`, `description: Skill number ${i}\nwhen_to_use: When ${i} matters`, "Body ".repeat(400));
        const cwd = project();
        loadSkills(cwd, true);
        const t = performance.now();
        const n = loadSkills(cwd, true).length;
        const ms = performance.now() - t;
        expect(n).toBe(200);
        // Measured at ~3ms on a laptop; generous for slow CI machines.
        expect(ms).toBeLessThan(250);
    });
});

describe("frontmatter YAML", () => {
    test("block scalars, folded and literal", () => {
        const { data, body } = parseSkillFrontmatter("---\ndescription: >\n  Folded onto\n  one line.\nnotes: |\n  Line one\n    indented\n  Line three\nname: x\n---\nBody");
        expect(data.description).toBe("Folded onto one line.");
        expect(data.notes).toBe("Line one\n  indented\nLine three");
        expect(data.name).toBe("x");
        expect(body).toBe("Body");
    });

    test("a # inside quotes isn't a comment", () => {
        const { data } = parseSkillFrontmatter('---\ndescription: "Triage issue #123 reports"\nhint: \'C # notes\'\nplain: value # comment\n---\n');
        expect(data).toEqual({ description: "Triage issue #123 reports", hint: "C # notes", plain: "value" });
    });

    test("continuation lines, lists, comments and single quotes", () => {
        const { data } = parseSkillFrontmatter("---\ndescription: Starts here\n  and continues\nallowed-tools:\n  - Read\n  - \"Bash(git:*)\"\nwhen_to_use: 'it''s time' # a comment\nempty:\n---\n");
        expect(data.description).toBe("Starts here and continues");
        expect(data["allowed-tools"]).toBe("Read, Bash(git:*)");
        expect(data.when_to_use).toBe("it's time");
        expect(data.empty).toBe("");
    });

    test("no frontmatter, or an unclosed one, is all body", () => {
        expect(parseSkillFrontmatter("Just text")).toEqual({ data: {}, body: "Just text" });
        expect(parseSkillFrontmatter("---\nname: x\nno end").data).toEqual({});
    });
});

describe("the skill's text", () => {
    test("arguments, the skill's folder, and edits made since it was listed", () => {
        skill(userSkills, "fix", "description: Fix", "Fix issue $1 in ${HARNESS_SKILL_DIR}/scripts (also ${CLAUDE_SKILL_DIR}). All: $ARGUMENTS");
        const [s] = loadSkills(project(), false);
        const text = formatSkill(s!, "42 urgent")!;
        expect(text).toStartWith(`<skill name="fix">\nBase directory for this skill: ${s!.dir}\n\n`);
        expect(text).toContain(`Fix issue 42 in ${s!.dir}/scripts (also ${s!.dir}). All: 42 urgent`);
        expect(text).toEndWith("</skill>");
        // No arguments: the body as written (`awk '{print $1}'` is a shell snippet, not a placeholder).
        expect(formatSkill(s!)).toContain("Fix issue $1 in");
        expect(formatSkill(s!)).toContain("All: $ARGUMENTS");
        // Arguments the body doesn't place are added after it.
        skill(userSkills, "fix", "description: Fix", "Changed body.");
        expect(formatSkill(s!, "extra")).toContain("Changed body.\n\nArguments: extra");
    });

    test("a skill deleted since it was listed", () => {
        skill(userSkills, "gone", "description: Soon gone");
        const [s] = loadSkills(project(), false);
        rmSync(join(userSkills, "gone"), { recursive: true });
        expect(formatSkill(s!)).toBeUndefined();
    });
});

describe("$name mentions", () => {
    const skills = () => {
        skill(userSkills, "pdf", "description: PDFs");
        skill(userSkills, "my-plugin:x", "description: Odd but valid");
        skill(userSkills, "home", "description: Named like $HOME");
        skill(userSkills, "hidden", "description: Model only\nuser-invocable: false");
        return loadSkills(project(), false);
    };

    test("known skills, once each, in order", () => {
        const s = skills();
        expect(skillMentions("use $pdf, then $home and $pdf again", s).map((x) => x.name)).toEqual(["pdf", "home"]);
        expect(skillMentions("($pdf) and $pdf:", s).map((x) => x.name)).toEqual(["pdf"]);
        expect(skillMentions("$Pdf counts too", s).map((x) => x.name)).toEqual(["pdf"]);
    });

    test("prices, shell variables, unknown names and words with a $ inside aren't mentions", () => {
        const s = skills();
        for (const text of ["costs $5", "$10k budget", "echo $HOME", "$PDF is shouted like a variable", "`$pdf` in code", "a$pdf", "$nope", "${pdf}", "$(pdf)", "$hidden"]) expect(skillMentions(text, s)).toEqual([]);
    });

    test("the skills come after the prompt as typed", () => {
        const s = skills();
        const out = withSkills("fill this in with $pdf", skillMentions("fill this in with $pdf", s));
        expect(out).toStartWith("fill this in with $pdf\n\n<skill name=\"pdf\">");
        expect(withSkills("no mentions", [])).toBe("no mentions");
    });
});

describe("the Skill tool", () => {
    test("no tool when the model can't load any skill", () => {
        expect(skillTool([])).toBeUndefined();
        skill(userSkills, "mine", "description: Mine\ndisable-model-invocation: true");
        expect(skillTool(loadSkills(project(), false))).toBeUndefined();
    });

    test("lists what the model may load; the same list gives the same tool", () => {
        skill(userSkills, "pdf", "description: Read PDFs\nwhen_to_use: A .pdf is mentioned");
        skill(userSkills, "mine", "description: Mine\ndisable-model-invocation: true");
        const list = loadSkills(project(), false);
        const tool = skillTool(list)!;
        expect(tool.description).toContain("- pdf: Read PDFs A .pdf is mentioned");
        expect(tool.description).not.toContain("mine");
        expect(skillTool(list)).toBe(tool);
        expect(tool.category).toBe("meta");
    });

    test("loads a skill, and refuses what it can't", async () => {
        skill(userSkills, "pdf", "description: Read PDFs", "Use pdftotext on $ARGUMENTS.");
        skill(userSkills, "mine", "description: Mine\ndisable-model-invocation: true");
        const list = loadSkills(project(), false);
        const tool = skillTool(list)!;
        const ok = await tool.run({ skill: "/PDF", args: "a.pdf" }, ctx);
        expect(ok.isError).toBeUndefined();
        expect(ok.content).toContain("Use pdftotext on a.pdf.");
        expect(ok.display?.summary).toBe("Loaded skill pdf");
        expect((await tool.run({ skill: "nope" }, ctx)).content).toBe('No skill named "nope". Skills you can load: pdf');
        expect((await tool.run({ skill: "mine" }, ctx)).content).toContain("can only be run by the user (/mine)");
        rmSync(join(userSkills, "pdf"), { recursive: true });
        const gone = await tool.run({ skill: "pdf" }, ctx);
        expect(gone.isError).toBe(true);
        expect(gone.content).toContain("no longer there");
    });

    test("a huge library is cut to a budget, saying how many are left out", () => {
        const many: Skill[] = Array.from({ length: 400 }, (_, i) => ({ name: `s${i}`, description: "d".repeat(400), modelInvocable: true, userInvocable: true, source: "user", file: "", dir: "" }));
        const listing = skillListing(many);
        expect(listing.length).toBeLessThan(13_000);
        expect(listing).toMatch(/- \(\d+ more not shown; call Skill with a name you know to load it\)$/);
        // Each description is cut too.
        expect(listing.split("\n")[0]!.length).toBeLessThan(320);
    });
});

describe("in the TUI", () => {
    function testApp(cwd = project()) {
        const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        const printed: string[] = [];
        const notices: string[] = [];
        (app as any).screen = { print: (f: any) => (printed.push(...(typeof f === "function" ? f(100) : [f]).map(String)), {}), replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true };
        (app as any).renderLive = () => {};
        app.notice = (m: string) => void notices.push(m);
        app.session = Session.create(app.cwd, { persist: false });
        const turns: { text: string; display?: string; kind?: string }[] = [];
        app.startTurn = (async (text: string, opts: { display?: string; kind?: string } = {}) => void turns.push({ text, ...opts })) as any;
        app.skills = loadSkills(cwd, true);
        return { app, printed, notices, turns };
    }

    test("/name runs the skill with its arguments; the transcript shows what was typed", async () => {
        skill(userSkills, "explain", "description: Explain code\nargument-hint: <path>", "Explain $ARGUMENTS simply.");
        const { app, turns } = testApp();
        expect(await runCommand(app, "/explain src/a.ts")).toBe(true);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ display: "/explain src/a.ts", kind: "command" });
        expect(turns[0]!.text).toContain("Explain src/a.ts simply.");
        const listed = commandList(app).find((c) => c.name === "explain")!;
        expect(listed.args).toBe("<path>");
        expect(stripAnsi(listed.description)).toBe("Explain code (skill)");
    });

    test("built-ins and custom commands keep their names; model-only skills aren't commands", async () => {
        skill(userSkills, "help", "description: A skill called help");
        skill(userSkills, "greet", "description: Skill greet");
        skill(userSkills, "background", "description: Model only\nuser-invocable: false");
        write(join(iso.home, "commands", "greet.md"), "Custom greet");
        const { app, turns, notices } = testApp();
        app.customCommands = (await import("../src/commands/custom")).loadCustomCommands(app.cwd, true);
        const names = commandList(app).map((c) => c.name);
        expect(names.filter((n) => n === "help" || n === "greet")).toEqual(["help", "greet"]);
        expect(names).not.toContain("background");
        await runCommand(app, "/greet");
        expect(turns[0]!.text).toBe("Custom greet");
        await runCommand(app, "/background");
        expect(notices.at(-1)).toContain("Unknown command /background");
        rmSync(join(iso.home, "commands"), { recursive: true, force: true });
    });

    test("a skill added after startup runs without a restart", async () => {
        const { app, turns } = testApp();
        skill(userSkills, "fresh", "description: New", "Brand new.");
        await runCommand(app, "/fresh");
        expect(turns[0]!.text).toContain("Brand new.");
    });

    test("a skill whose file went away says so and keeps the draft", async () => {
        skill(userSkills, "vanish", "description: Vanishes");
        const { app, notices, turns } = testApp();
        rmSync(join(userSkills, "vanish"), { recursive: true });
        const restored: unknown[] = [];
        (app.editor as any).restore = (d: unknown[]) => restored.push(...d);
        await runCommand(app, "/vanish now", { text: "/vanish now", attachments: new Map() });
        expect(turns).toEqual([]);
        expect(notices.at(-1)).toContain("The vanish skill is gone");
        expect(restored).toHaveLength(1);
    });

    test("on Claude Code and Codex, every skill's /name goes to the CLI as typed (the backend runs it natively)", async () => {
        skill(claudeSkills, "cc-skill", "description: Claude Code has it", "CC body");
        skill(userSkills, "harness-skill", "description: Only here", "Harness only");
        for (const provider of ["claude-code", "codex"]) {
            const { app, turns } = testApp();
            app.model = { id: "default", provider } as any;
            await runCommand(app, "/cc-skill a");
            await runCommand(app, "/harness-skill b");
            expect(turns.map((t) => t.text)).toEqual(["/cc-skill a", "/harness-skill b"]);
        }
    });

    test("on Codex, its own skills are in the $ menu once it has listed them", () => {
        skill(userSkills, "deploy", "description: Ship it", "Deploy.");
        const { app } = testApp();
        app.model = { id: "default", provider: "codex" } as any;
        app.cliCommands = { provider: "codex", names: new Set(["imagegen", "deploy"]) };
        const labels = (text: string) => {
            app.editor.set(text);
            return ((app as any).completions()?.items ?? []).map((i: any) => i.label);
        };
        expect(labels("use $")).toEqual(expect.arrayContaining(["$deploy", "$imagegen"]));
        expect(labels("use $").filter((l: string) => l === "$deploy")).toHaveLength(1);
        app.model = { id: "m", provider: "anthropic" } as any;
        expect(labels("use $")).not.toContain("$imagegen");
    });

    test("on Claude Code, its own commands and skills go to it instead of being refused", async () => {
        skill(userSkills, "shared", "description: Both have it", "Harness body");
        const { app, turns, notices } = testApp();
        app.model = { id: "default", provider: "claude-code" } as any;
        // Before it has listed its commands: let it resolve the name.
        expect(await runCommand(app, "/code-review high")).toBe(false);
        app.cliCommands = { provider: "claude-code", names: new Set(["code-review", "shared"]) };
        expect(await runCommand(app, "/code-review")).toBe(false);
        // One it lists itself runs as its own; one it doesn't is refused.
        await runCommand(app, "/shared x");
        expect(turns[0]).toMatchObject({ text: "/shared x" });
        expect(await runCommand(app, "/not-a-thing")).toBe(true);
        expect(notices.at(-1)).toContain("Unknown command /not-a-thing");
        // Another model: Claude Code's list doesn't apply.
        app.model = { id: "m", provider: "anthropic" } as any;
        expect(await runCommand(app, "/code-review")).toBe(true);
        await runCommand(app, "/shared y");
        expect(turns[1]!.text).toContain("Harness body");
    });

    test("/skills lists them with where they come from, and says how to add one when there are none", async () => {
        const empty = testApp();
        await runCommand(empty.app, "/skills");
        expect(stripAnsi(empty.printed.join("\n"))).toContain("None yet.");
        expect(stripAnsi(empty.printed.join("\n"))).toContain("Add one as <name>/SKILL.md in");
        skill(userSkills, "pdf", "description: Read PDFs\nargument-hint: [file]");
        skill(userSkills, "bg", "description: Background\nuser-invocable: false");
        const { app, printed } = testApp();
        await runCommand(app, "/skills");
        const out = stripAnsi(printed.join("\n"));
        expect(out).toContain("pdf [file] (user)");
        expect(out).toContain("bg (user, model only)");
        expect(out).toContain("SKILL.md");
        printed.length = 0;
        await runCommand(app, "/skills zzz");
        expect(stripAnsi(printed.join("\n"))).toContain('No skill matches "zzz".');
    });

    test("$ completes skill names where the cursor is", () => {
        skill(userSkills, "pdf", "description: Read PDFs");
        skill(userSkills, "pptx", "description: Slides");
        skill(userSkills, "bg", "description: Background\nuser-invocable: false");
        const { app } = testApp();
        app.editor.set("fill it with $p");
        const menu = (app as any).completions();
        expect(menu.items.map((i: any) => i.label)).toEqual(["$pdf", "$pptx"]);
        (app as any).applyCompletion(menu, false);
        expect(app.editor.text).toBe("fill it with $pdf ");
        app.editor.set("echo $HOME");
        expect((app as any).completions()).toBeUndefined();
        app.editor.set("$b");
        expect((app as any).completions().items).toEqual([]);
    });
});
