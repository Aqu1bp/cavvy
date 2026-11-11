# Themes

Settings → Appearance → Theme changes the whole window: its colours, the corners of its controls and its typeface. Nine come with Cavvy; **New theme** makes one of your own from the theme in use.

| Choice | What it changes |
|---|---|
| Colour | The hue of the window, its surfaces and text, and how much of that hue they carry (none is pure grey) |
| Accent | Send, primary buttons, links, focus and the open session's mark |
| Corners | Sharp, soft or round controls |
| Typeface | The system's, a serif for what's read at length, or monospace throughout |

A theme works in both colour schemes. Window, Window tint, Contrast and Accent still apply over it; Accent's first swatch is the theme's own.

## Sharing one

**Copy theme** puts a theme on the clipboard as a line of text; **Import** takes one. The text holds the choices above and a name, nothing else:

```json
{"cavvyTheme":1,"name":"Harbour","hue":228,"tint":0.85,"accent":"#3a9fc8","shape":"soft","typeface":"system"}
```

`hue` is in degrees (0–360, as in OKLCH), `tint` from 0 to 1, `accent` a `#rrggbb` colour. `shape` is `sharp`, `soft` or `round`; `typeface` is `system`, `serif` or `mono`. Both are optional.

## Why a theme can't be unreadable

A theme doesn't list colours. Every colour is worked out from its choices (`gui/src/lib/theme.ts`): surfaces as steps of lightness in the theme's hue, then each text colour moved just far enough from the surfaces it sits on to reach WCAG AA (4.5:1). An accent too pale or too dark for its label keeps its hue and moves in lightness until the label reads.

`test/theme.test.ts` holds this to the same contrast matrix as the default look (`test/contrast.test.ts`): each built-in theme under every Window, tint, Contrast and accent setting, and several hundred recipes drawn at random.

## For contributors

- `gui/src/styles/tokens.css` holds what the default theme gives, between its `palette` marks. Don't edit it there: change `derive()` or `DEFAULT_THEME` and run `bun scripts/theme-tokens.ts`. A new colour token is added to `derive()`, so every theme has it.
- A theme's palette is worked out when it's picked and saved with the preferences, so startup only applies it (`gui/public/theme-boot.js`). Raise `LOOK_VERSION` (`gui/src/state/prefs-core.ts`) when `derive()` changes what it gives: saved palettes are then worked out again at the next start.
- Corners are written `calc(N * var(--rs))` and a control's corner `var(--r-ctl)`, so a theme's shape reaches them. A capsule that must stay one (a toggle, a bar, a count) uses `var(--r-full)`.
- Text read at length uses `var(--font-prose)`; everything else `var(--font-ui)`.
