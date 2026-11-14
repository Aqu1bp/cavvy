// ThemeList and ThemeSet: an agent makes the user a theme, or shows one, from any provider. API models get them as
// Cavvy tools; Claude Code and Codex through Cavvy's MCP server (theme_list, theme_set). The theme goes in the call
// itself, so an agent whose sandbox can't write outside the project (Codex's) can make one too. Cavvy checks it,
// saves it to ~/.cavvy/themes, shows it in this machine's windows and says how it came out.

import type { ServerTool, ServerToolResult } from "../mcp/server";
import type { Tool, ToolContext, ToolResult } from "../tools/types";
import { BUILTINS, builtin, BUILTIN_IDS } from "./builtin";
import { checkTheme, ID, LIMITS, onlyScheme, STAGE, type Theme, type ThemeEntry } from "./format";
import { listThemes, readThemeFile, saveTheme } from "./store";

export const THEME_TOOL_NAMES = ["ThemeList", "ThemeSet"];
export const THEME_SERVER_TOOLS = ["theme_list", "theme_set"];

/** How to write one: returned by ThemeList, so it costs nothing until an agent needs it. */
export const THEME_GUIDE = `How to make a Cavvy theme

A theme is JSON: { "name": "…", "light": Look, "dark": Look }. Give it a light look, a dark look or both: with one, the window switches to that kind while the theme shows. With both, it follows the user's light/dark setting, so make both when the idea works either way.

Look = {
  "colors": { "background": "#hex", "text": "#hex", "accent": "#hex" },  // accent optional: buttons, links, focus
  "layers": [Layer, …],   // optional: the scene behind the window, back to front. None: the window only takes the colours.
  "veil": 0.3            // optional: the least share of the background laid over the scene, 0–1
}
Cavvy works out every other colour (dimmer text, cards, lines, popovers, diff and status colours) from these three and keeps all text at WCAG AA. Text on the background must be at least 5.5:1. A light look's background must be light and a dark look's dark.

Layer = { "svg": "<svg …>…</svg>", "x": 0, "y": 0, "width": ${STAGE.width}, "height": ${STAGE.height}, "opacity": 1, "origin": [0.5, 0.5], "motion": Motion, "when": "working" }
- Layers sit on a ${STAGE.width} × ${STAGE.height} stage scaled to cover the window (the edges are cropped when the window's shape differs; a 1440 × 900 window shows it all). x, y, width and height are in stage units; the default is the whole stage. A box may reach past the stage (a rain sheet taller than it, a cloud drifting in from off the edge). origin is the point rotate and scale turn about, as fractions of the box: [0.5, 1] is the middle of its bottom edge.
- Each svg is a still picture, drawn as an image: no scripts, no external links or fonts, no CSS or SMIL animation (it won't move). Gradients, paths, patterns, masks and filters are fine; <text> works in the system's fonts, though words behind a conversation distract. Give it a viewBox; preserveAspectRatio="none" makes it fill its box exactly.
- An svg with a filter (a blur, a glow) is drawn at its own size and then scaled, so it goes soft when its box is bigger than its width and height: give it width and height near its box, and keep crisp shapes in a layer of their own, without the filter.
- Make the first layer a full-stage picture that doesn't move (sky, walls, ground). Make each moving thing its own small layer with a box just big enough for it: the compositor moves it without redrawing anything. Every moving layer holds its picture in graphics memory for as long as the theme shows, so a few full-stage moving layers are fine and dozens are not: group small things that move together into one layer.
- Up to ${LIMITS.layers} layers, ${LIMITS.svg} characters per svg, ${LIMITS.total} in all.

Motion = { "duration": 12, "keyframes": [Keyframe, …], "loop": "alternate" | "repeat", "easing": "ease" | "linear", "delay": -4 }
Keyframe = { "at": 0–1, "x": 0, "y": 0, "rotate": 0, "scale": 1, "opacity": 1 }
- x and y move the layer from where it is (stage units), rotate in degrees about origin, scale about origin, opacity times the layer's. A field left out is at rest (0, or 1 for scale and opacity), not the keyframe before's. 2–${LIMITS.keyframes} keyframes; "at" places each in the loop (give it to all or none: none spreads them evenly; first 0, last 1).
- "alternate" (default) goes back and forth: for sway, drift, breathing. "repeat" starts over: for falling, rising, orbiting (rotate 0 → 360, linear) and twinkles; hide the jump back with opacity 0 at both ends.
- Negative delays start a layer part way through, so copies don't move in step.
- Motion runs at 20 steps a second, which suits slow movement: drifts over 10–60 s, sways of a few degrees, slow twinkles. Fast small movement looks jerky. When the user's system asks for reduced motion, or they turn Animate off, every layer rests at its first keyframe: make that a good picture.

"when": "working" shows a layer only while the agent in the session on screen is working; "idle" only while it isn't. They fade in and out. Use it for something that tells the user at a glance work is under way: rain getting heavier, more fireflies, a lighthouse beam turning.

Making it look good
- The conversation runs down the middle of the window, the session list down the left (about the first 280 units) and an optional panel down the right. Keep the middle calm and low in contrast; put the interest at the edges, the corners, the top and the bottom.
- Cavvy lays the background colour over the scene, in each part as much as the text there needs to read; theme_set says how much and sends a picture of the window with the theme on. Look at it and refine. A scene close to the background in lightness keeps that low and the art visible: a dark look with a dark scene and a few bright accents, a light look with a pale scene.
- Choose the background from the scene's own colours, and an accent that belongs to it.
- Give it depth: two or three planes moving at different speeds (far slow, near faster).

theme_set saves it under an id (lowercase letters, digits and hyphens) and shows it at once. Saving again under the same id replaces it, and the window changes as you go: show a first version early, then refine it. To start from an existing theme, theme_list with its id gives its JSON.`;

const served = (text: string) => text.replaceAll("ThemeList", "theme_list").replaceAll("ThemeSet", "theme_set");

const schemesOf = (t: Theme) => (["light", "dark"] as const).filter((s) => t[s]).join(" and ");

async function themeById(id: string): Promise<{ theme?: Theme; problems?: string[] }> {
    const b = builtin(id);
    if (b) return { theme: await b.load() };
    const e = readThemeFile(id);
    return e.theme ? { theme: e.theme } : { problems: e.problems };
}

export async function themeList(input: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    if (typeof input.id === "string" && input.id.trim()) {
        const id = input.id.trim();
        if (!ID.test(id)) return { text: `No theme "${id}". ThemeList with no id lists them.`, isError: true };
        const { theme, problems } = await themeById(id);
        if (theme) return { text: JSON.stringify(theme) };
        return { text: problems?.[0]?.startsWith("can't be read") ? `No theme "${id}". ThemeList with no id lists them.` : `The theme file "${id}" doesn't check out:\n- ${problems?.join("\n- ")}`, isError: true };
    }
    const mine = listThemes();
    const line = (e: ThemeEntry) => (e.theme ? `- ${e.id}: ${e.theme.name} (${schemesOf(e.theme)})` : `- ${e.id}: doesn't check out: ${e.problems?.[0]}`);
    return {
        text: [
            "Built in (can't be changed; copy one under a new id):",
            ...BUILTINS.map((b) => `- ${b.id}: ${b.name} (${b.schemes.join(" and ")})`),
            "",
            mine.length ? "The user's own (~/.cavvy/themes):" : "The user has no themes of their own yet.",
            ...mine.map(line),
            "",
            THEME_GUIDE,
        ].join("\n"),
    };
}

/** What the call says when a theme was shown (or wasn't): what the window reported. */
function outcome(name: string | undefined, shown: Awaited<ReturnType<NonNullable<ToolContext["ui"]["showTheme"]>>>, saved?: string): string {
    const before = saved ? `Saved to ${saved}. ` : "";
    if (!shown.sent) return `${before}No Cavvy window is open to show it${name ? `; the user can pick it in Settings → Appearance → Theme` : ""}.`;
    const r = shown.report;
    if (!r) return `${before}Sent to the window, which didn't say how it came out.`;
    if (!name) return "The theme is off.";
    if (!r.shown) return `${before}The window couldn't show it.`;
    const parts = [`${before}Showing "${name}" (${r.scheme}).`];
    if (typeof r.veil === "number" && (r.veilMost ?? r.veil) > 0) {
        const pct = Math.round(r.veil * 100);
        const most = Math.round((r.veilMost ?? r.veil) * 100);
        parts.push(`For text to read, the window lays its background over the scene: ${pct}% on average, ${most}% where the scene is busiest.${pct >= 60 ? " That hides much of it: bring the scene's lightness nearer the background's to show more." : ""}`);
    }
    if (r.failed?.length) parts.push(`Layers ${r.failed.map((i) => `[${i}]`).join(", ")} couldn't be drawn: each must be one well-formed SVG document.`);
    if (r.still) parts.push("Its motion is resting: the user has reduced motion or Animate off.");
    return parts.join(" ");
}

export async function themeSet(input: Record<string, unknown>, ctx: Pick<ToolContext, "ui">): Promise<{ text: string; isError?: boolean; summary?: string; picture?: string }> {
    const show = ctx.ui.showTheme?.bind(ctx.ui);
    if (!show) return { text: "Themes show in Cavvy's window on the user's own computer; this session can't set one.", isError: true };
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (id === "none") {
        const r = await show(null);
        return { text: r.sent ? "The theme is off." : "No Cavvy window is open.", summary: "Theme off" };
    }
    if (!ID.test(id)) return { text: 'id must be lowercase letters, digits and hyphens (like "tokyo-rain"), or "none" to turn the theme off.', isError: true };
    let theme: Theme;
    let entry: ThemeEntry | undefined;
    let path: string | undefined;
    if (input.theme !== undefined && input.theme !== null) {
        if (BUILTIN_IDS.has(id)) return { text: `"${id}" is a built-in theme: save yours under another id. ThemeList with id "${id}" gives its JSON to start from.`, isError: true };
        let raw = input.theme;
        if (typeof raw === "string") {
            try {
                raw = JSON.parse(raw);
            } catch (e) {
                return { text: `theme isn't JSON: ${(e as Error).message}`, isError: true };
            }
        }
        const checked = checkTheme(raw);
        if (!checked.theme) return { text: `Not saved. To fix:\n- ${checked.problems.join("\n- ")}`, isError: true };
        theme = checked.theme;
        path = saveTheme(id, theme);
        entry = { id, theme };
    } else {
        const found = await themeById(id);
        if (!found.theme) return { text: found.problems?.[0]?.startsWith("can't be read") ? `No theme "${id}": give its JSON as theme to make it. ThemeList lists the ones there are.` : `The theme file "${id}" doesn't check out:\n- ${found.problems?.join("\n- ")}`, isError: true };
        theme = found.theme;
    }
    const r = await show(id, entry);
    const only = onlyScheme(theme);
    const picture = r.report?.shown ? r.report.picture : undefined;
    const text = outcome(theme.name, r, path) + (only && r.report?.shown ? ` It has a ${only} look only, so the window is ${only} while it shows.` : "") + (picture ? "\n\nThe picture is the window with it on, at rest and not working, the app sketched over it with made-up text. Check the text reads, the middle stays calm and the scene looks as you meant; then refine and set it again." : "");
    return { text, summary: theme.name, ...(picture ? { picture } : {}) };
}

const asResult = (r: { text: string; isError?: boolean; summary?: string; picture?: string }): ToolResult => ({
    content: r.text,
    isError: r.isError,
    ...(r.picture ? { images: [{ type: "image" as const, mediaType: "image/jpeg", data: r.picture }] } : {}),
    display: { summary: r.isError ? undefined : r.summary },
});

const LIST_DESCRIPTION = "List Cavvy's themes (built in, and the user's own), with how to make one; with an id, that theme's JSON. Call it before making or changing a theme.";
const SET_DESCRIPTION = `Change how Cavvy's window looks: show a theme by id, or make one by giving its JSON as theme (saved under id, replacing one of the user's own of that id), or id "none" to turn the theme off. ThemeList gives the format; read it first. Answers how it came out in the window, or what to fix.`;

const LIST_SCHEMA = { type: "object", properties: { id: { type: "string", description: "A theme's id, for its JSON." } } };
const SET_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: 'The theme\'s id: lowercase letters, digits and hyphens. "none" turns the theme off.' },
        theme: { type: "object", description: "The theme's JSON, as ThemeList describes, to save under id and show. Leave it out to show a theme that exists." },
    },
    required: ["id"],
};

export const ThemeListTool: Tool<{ id?: string }> = {
    name: "ThemeList",
    description: LIST_DESCRIPTION,
    parameters: LIST_SCHEMA,
    category: "meta",
    readOnly: true,
    title: (i) => (typeof i.id === "string" && i.id ? `ThemeList(${i.id})` : "ThemeList"),
    async run(input) {
        return asResult(await themeList(input));
    },
};

export const ThemeSetTool: Tool<{ id: string; theme?: unknown }> = {
    name: "ThemeSet",
    description: SET_DESCRIPTION,
    parameters: SET_SCHEMA,
    category: "meta",
    readOnly: false,
    title: (i) => `ThemeSet(${typeof i.id === "string" ? i.id : ""})`,
    async run(input, ctx) {
        return asResult(await themeSet(input, ctx));
    },
};

export const THEME_TOOLS: Tool<any>[] = [ThemeListTool, ThemeSetTool];

/** theme_list and theme_set for Claude Code and Codex: the same tools, run through Cavvy's checks. */
export function themeServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>): ServerTool[] {
    return THEME_TOOLS.map((tool, i) => ({
        name: THEME_SERVER_TOOLS[i]!,
        title: i === 0 ? "List Cavvy's themes" : "Change Cavvy's theme",
        description: served(tool.description),
        inputSchema: tool.parameters,
        annotations: { readOnlyHint: i === 0, destructiveHint: false, openWorldHint: false },
        call: async (args, { signal, meta }) => {
            const r = await run(tool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined);
            return { ...r, text: served(r.text) };
        },
    }));
}

/** The served name a tool goes by, or undefined. */
export function servedThemeName(tool: string): string | undefined {
    const i = THEME_TOOL_NAMES.indexOf(tool);
    return i >= 0 ? THEME_SERVER_TOOLS[i] : undefined;
}

export const THEME_INSTRUCTIONS = `# Themes (cavvy)

To change how Cavvy's window looks (its colours, an animated scene behind it), when the user asks: theme_list first (it says how to make one), then theme_set.`;
