# Themes

A theme changes how the window looks: its colours, and optionally an animated scene behind it. Pick one in **Settings → Appearance → Theme** (or `/theme`), or ask any agent for one ("make me a theme of a rainy Tokyo alley"). **Make one** in the gallery starts a new session with that request typed in.

## Built in

Bloom (light and dark), Komorebi, Meadow (light), Night Rain, Fireflies, Orbit, Glowworms (dark). A theme with only one look switches the window to that kind while it shows; the scheme tiles say so. Each scene has something that changes while the agent in the session on screen works: heavier rain, more fireflies, seeds coming loose.

## Made by agents

API models get two tools, `ThemeList` and `ThemeSet`; Claude Code and Codex get the same as `mcp__cavvy__theme_list` and `mcp__cavvy__theme_set` from Cavvy's MCP server. `ThemeList` lists the themes and returns the guide to the format (so the guide costs nothing until an agent needs it); with an id it returns that theme's JSON with its long layers left out, and with an id and a layer (`"dark.3"`) that layer's SVG. In `ThemeSet`, a layer given as `{"copy": "night-rain:dark:3"}` reuses that layer (other keys change it), so "Night Rain in purple" needs no SVG written out. `ThemeSet` takes an id and the theme's JSON, checks it, saves it to `~/.cavvy/themes/<id>.json` and shows it in this Mac's windows. The answer says how it came out: how much of the background had to be laid over the scene for text to read, layers that couldn't be drawn, whether motion is resting. It also includes a picture of the window with the theme on, with the app drawn over it in made-up text, so the agent can see what it made and refine it. The picture never shows your sessions or messages. Saving again under the same id replaces the theme and the window changes as it goes. Built-in themes can't be overwritten; an agent copies one under a new id.

The theme tools aren't offered to Cavvy's own sub-agents, in sessions on a server (the theme is per device, and the server has no window), or to ACP agents. A window on a server shows this device's theme: its gallery has the built-ins and the theme showing, and doesn't list or delete the server's themes.

## The format

```json
{
  "name": "Dusk",
  "dark": {
    "colors": { "background": "#150f24", "text": "#efeaf8", "accent": "#b59cff" },
    "layers": [
      { "svg": "<svg …>…</svg>" },
      { "svg": "<svg …>…</svg>", "x": 1300, "y": 80, "width": 200, "height": 200,
        "motion": { "duration": 6, "keyframes": [{ "x": -60 }, { "x": 60 }] } }
    ]
  }
}
```

- **Colours.** A look gives three: background, text and an optional accent. Cavvy derives every other colour from them (dimmer text, cards, lines, popovers, diffs, status colours) and keeps all text at WCAG AA. Text on the background must reach 5.5:1, so dimmer text derived from it still reads. A light look's background must be light and a dark look's dark.
- **Layers** are still SVG pictures on a 1600 × 1000 stage scaled to cover the window, back to front. Each is drawn as an image, so it can't run scripts, load anything from the network or animate itself. Cavvy refuses `<script>`, `<foreignObject>`, event attributes and external references anyway, and SVG or CSS animation inside a layer, including an SVG or GIF embedded in it (motion goes in `motion`, where Cavvy controls it). Up to 60 layers, 120,000 characters per SVG, 800,000 in all.
- **Motion** is keyframes of position, rotation, scale and opacity. Cavvy turns them into CSS animations of transform and opacity only, stepped at 20 a second like the app's other endless animations, so the compositor moves the layers without redrawing anything. A layer costs memory for its whole box, so a scene that's only at the sides is cheaper as a layer per side (as Night Rain does).
- **`when`**: `"working"` shows a layer only while the session on screen works, `"idle"` only while it doesn't. They fade in and out.
- **The veil.** For text to read, Cavvy lays the theme's background over the scene, measured per region from the scene's own pixels, posed through its motion often enough that nothing skips a region: a dark corner gets none, a bright cloud that drifts behind text gets as much as it needs where it passes. `"veil"` sets a minimum.

The full guide an agent reads is `THEME_GUIDE` in `src/themes/tools.ts`.

## Motion and cost

**Settings → Appearance → Animate** rests the scene, as does macOS's Reduce motion: every layer stays at its first keyframe. With Reduce transparency the background lies over most of the scene. A theme with no scene costs nothing beyond its colours. The scene's code loads only when a theme is chosen.

## Files

Themes are JSON files in `~/.cavvy/themes`. Cavvy watches the folder, so a theme edited by hand or by any tool shows at once. If an edit breaks the theme that's showing, a toast says so, the window keeps its last good version, and the tile in Settings says what's wrong. Deleting a theme from the gallery offers Undo. The chosen theme is per device (it's a window preference) and the window shows its colours from the first paint.
