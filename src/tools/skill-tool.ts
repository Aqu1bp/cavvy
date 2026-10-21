import type { Tool } from "./types";
import { formatSkill, type Skill } from "../agent/skills";

/** What the listing may take of every request: a big skill library shouldn't crowd out the conversation. */
const LISTING_BUDGET = 12_000;
const MAX_ENTRY = 300;

type SkillInput = { skill: string; args?: string };

/**
 * The Skill tool for `skills` (the session's current list), or undefined when
 * none can be loaded by the model, so no tool is sent at all. The same list
 * gives the same tool, so its description doesn't change between requests.
 */
export function skillTool(skills: readonly Skill[]): Tool<SkillInput> | undefined {
    if (cache.has(skills)) return cache.get(skills);
    const listed = skills.filter((s) => s.modelInvocable);
    const tool = listed.length ? makeTool(skills, listed) : undefined;
    cache.set(skills, tool);
    return tool;
}

const cache = new WeakMap<readonly Skill[], Tool<SkillInput> | undefined>();

export function skillListing(listed: readonly Skill[]): string {
    const lines: string[] = [];
    let used = 0;
    for (const s of listed) {
        const what = [s.description, s.whenToUse].filter(Boolean).join(" ");
        const line = `- ${s.name}: ${what.length > MAX_ENTRY ? what.slice(0, MAX_ENTRY - 1) + "…" : what}`;
        if (used + line.length > LISTING_BUDGET) {
            lines.push(`- (${listed.length - lines.length} more not shown; call Skill with a name you know to load it)`);
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    return lines.join("\n");
}

function makeTool(all: readonly Skill[], listed: readonly Skill[]): Tool<SkillInput> {
    return {
        name: "Skill",
        category: "meta",
        readOnly: true,
        description: `Loads a skill: instructions, and sometimes scripts and reference files, for a kind of task. When the user's request matches a skill below, call this first, before doing the task, and then follow the instructions it returns. The user may also refer to a skill as /name or $name.

Don't load a skill that's already in the conversation (a <skill name="..."> block); follow it. Only use names listed here.

<available_skills>
${skillListing(listed)}
</available_skills>`,
        parameters: {
            type: "object",
            properties: {
                skill: { type: "string", description: 'The skill\'s name, e.g. "pdf" or "my-plugin:review"' },
                args: { type: "string", description: "Optional arguments for the skill" },
            },
            required: ["skill"],
        },
        title: (i) => `Skill(${i.skill ?? ""})`,
        async run(input) {
            const name = String(input.skill ?? "").trim().replace(/^[/$]/, "").toLowerCase();
            const skill = all.find((s) => s.name === name);
            if (!skill) return { content: `No skill named "${name}". Skills you can load: ${listed.map((s) => s.name).join(", ")}`, isError: true };
            if (!skill.modelInvocable) return { content: `The "${name}" skill can only be run by the user (/${name}).`, isError: true };
            const text = formatSkill(skill, typeof input.args === "string" ? input.args.trim() : "");
            if (text === undefined) return { content: `The "${name}" skill's SKILL.md is no longer there (${skill.file}).`, isError: true };
            return { content: text, display: { summary: `Loaded skill ${name}` } };
        },
    };
}
