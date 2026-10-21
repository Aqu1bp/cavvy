# Porting the glass redesign into `gui/`

The interactive mockup in this folder (`index.html`, `styles.css`, `app.js`) is the
signed-off design. Open `index.html` in a browser to use it: the bar at the bottom
switches theme, wallpaper and window size; it is not part of the design. The user
went through it screen by screen; ship what it shows.

## Rules for every pull request

1. **Rebuild, don't reskin.** Match the mockup's structure, spacing, radii, type
   sizes, motion and copy, not only its colours. Read the mockup's CSS for the area
   you own and port the values. When the real app and the mockup differ in
   *behaviour*, the real app wins; when they differ in *look or layout*, the mockup wins.
2. **Lose no feature.** The real app has things the mockup leaves out (sub-agent
   views, runs, goal/queue/schedule tabs, MCP, scripts, worktrees, compare, images,
   accounts, …). Keep every one, restyled in the mockup's language: same tokens,
   radii, pills, glass rules. If you can't tell how something should look, follow
   the nearest mockup equivalent and say so in the PR.
3. **Stay in your files.** Each area below lists the files it owns. Don't edit
   another area's files; if you need a change there, say so in your PR description
   instead. `gui/src/styles/tokens.css` belongs to the foundation PR only.
4. **Tokens only.** No raw colours in component CSS. Use the tokens below. If one is
   missing, ask the coordinator instead of adding a colour.
5. **Check it visually.** Build (`bun run gui:build`), run the demo
   (`bun run gui:demo --port 46xx --token <16+ chars>`; prompts containing "demo",
   "plan", "question" or "todo" drive the mock model) and compare against the mockup
   at 1360×880, 1024×700 and 720×480, light and dark. `tools/drive.ts` drives a
   headless Chrome over CDP and screenshots each step (see its header). Put the
   screenshots' paths in the PR description.
6. **Usual repo rules** (AGENTS.md): own worktree and branch, one change per PR,
   `bun run typecheck` and `bun run gui:typecheck`, targeted tests only
   (`bun test ./test/<file>.test.ts`), then push and let CI run the suite.
   Update or add tests where behaviour changes (keyboard handling, prefs migration,
   layout decisions that live in TS).

## The three layers

1. **The window is glass.** In the app it's macOS's own material: Tauri
   `transparent: true` + `windowEffects: { effects: ["liquidGlassRegular", "sidebar"] }`
   (Liquid Glass on macOS 26+, falls back to the sidebar vibrancy material on older
   macOS; verified in tauri 2.12.4 `src/vibrancy/macos.rs`). The page background is
   transparent; `--win-tint` is laid over the native glass. In a plain browser there
   is no native glass: paint a calm gradient backdrop and the tint over it.
   The session rail sits straight on the glass, no card.
2. **One opaque sheet** (`--sheet`, radius `--r-sheet`, `--sheet-shadow`) holds the
   work: conversation | inspector (hairline split, inspector on `--insp-bg`), and the
   terminal as a bottom row spanning both.
3. **Controls float over the sheet as small glass pieces** (`.glass`: `--ctl`
   background, backdrop blur 20px saturate 1.9, `--ctl-stroke` hairline,
   `--ctl-hi`/`--ctl-lo` inner highlights, `--ctl-shadow`, `--sheen` overlay): the
   title-bar capsule, the composer, request cards, menus, popovers, the palette,
   toasts.
   `[data-glass="solid"]` and `prefers-reduced-transparency` drop every
   backdrop-filter.

Shape rule: containers 12–18px radius; every control is a full pill (`--pill`).

## Tokens (the contract; the foundation PR defines them)

New, from the mockup's `:root` / `[data-theme]` blocks (values there):
`--sheet --sheet-2 --insp-bg --term-bg --group --seg-on --sheet-shadow`
`--fg --fg-2 --fg-3 --fg-4 --line --hover --press`
`--win-tint --win-stroke --win-hi`
`--ctl --ctl-strong --ctl-stroke --ctl-hi --ctl-lo --ctl-shadow --pop-shadow --sheen`
`--rail-fg --rail-fg-2 --rail-sel --rail-sel-stroke --rail-hover --rail-float`
`--ok --warn --warn-bg --danger --add-* --del-* --find --find-cur`
`--r-window --r-sheet --r-card --pill --ease --spring --dur`

The existing names (`--bg`, `--bg-card`, `--fg-muted`, `--border`, `--accent`,
`--shiki-*`, `--radius-*`, `--dur-panel`, …) stay defined, pointed at the new
palette, so areas not yet ported keep working. The last PR removes the aliases.

Appearance prefs (foundation): scheme System/Light/Dark, accent (the app's nine
accents), **Window** Glass/Tinted/Solid (`data-glass`), **Contrast**
Standard/High, text size, density, chat width, animations. The six named themes go;
saved prefs migrate (paper/light → light, dark/midnight/dusk → dark,
contrast → dark + high contrast).

## Areas, owners and files

| Area | Owns | Mockup reference |
|---|---|---|
| **F. Foundation** | `styles/tokens.css`, `styles/base.css`, `public/theme-boot.js`, `state/prefs.ts`, `lib/platform.ts` (native theme), Settings → Appearance section, `desktop/src-tauri/tauri.conf.json`, `design/glass/` (this folder, committed) | Tokens, Base, Glass, Settings → Appearance |
| **S. Shell** | `App.tsx` (window structure, SessionView), `styles/shell.css`, `styles/stage.css`, `styles/panel.css` (the inspector container only), `styles/home.css` layout, `TerminalPanel.tsx` placement + `styles/terminal.css`, `state/ui.ts` | Desktop and window, Sheet, Terminal, `layout()` in app.js |
| **C. Composer** | `Composer.tsx`, `ModelPicker.tsx`, `ModePicker.tsx`, `ComposerMeter.tsx`, `InteractionDock.tsx`, `QueueTab.tsx`, `GoalTab.tsx`, `ScheduleTab.tsx`, `AttachmentChips.tsx`, `styles/composer.css` | Dock: prompts + composer, effort bars, context card |
| **T. Transcript** | `Transcript.tsx`, `TurnView.tsx`, `blocks/*`, `Agents.tsx`, `styles/transcript.css`, `styles/markdown.css`, `styles/agent-view.css` | Transcript |
| **R. Rail + title bar** | `Sidebar.tsx` (+ SettingsNav), `Header.tsx`, `ProjectScripts.tsx`, `RunSwitcher.tsx`, `lib/toasts.ts` + toasts component, `styles/sidebar.css`, `styles/header.css`, `styles/project-scripts.css`, `styles/toasts.css`, `styles/runs.css` | Rail, `.bar`/`.cap`, toasts |
| **O. Overlays + Settings pages** | `CommandPalette.tsx`, `FindBar.tsx`, `ui/*` (Dialog, Popover, Menu, ConfirmDialog, bits), every `*Dialog.tsx`, `Settings.tsx` (all sections but Appearance), `UsageView.tsx`, `Accounts.tsx`, `Home.tsx` content, `styles/overlays.css`, `styles/settings.css`, `styles/usage.css`, `styles/accounts.css` | Popovers, Settings, Home |
| **I. Inspector + diff reader** (after PR #178 merges) | `RightPanel.tsx`, `ReviewPane.tsx`, `blocks/DiffView.tsx` look, panel content CSS | Inspector, diff reader |

## Behaviour the mockup settled (port these, they're decisions)

- **Responsive** (`layout()` in app.js): rail docks at window width ≥ 900, else an
  overlay drawer (⌘B) with a dim scrim, click-outside closes. The inspector docks
  when the conversation keeps ≥ 480px; otherwise it floats (top 54px, right 8px)
  and ends above the composer/request dock; if that leaves < 260px it takes the full
  height and closes when a request arrives. Shrinking the window past the docking
  point closes a docked inspector (unless the diff reader is open). The diff reader
  widens the inspector to `min(860, max(width, 55% of sheet))` (split view:
  `min(1120, max(width, 68%))`).
- **Terminal**: bottom row of the sheet under conversation + inspector, tabs,
  resize; the conversation keeps ≥ 300px; maximize makes the terminal the whole
  sheet (conversation and inspector hidden, not squeezed).
- **Title bar**: title (double-click renames) + branch, project name before the
  title when the rail is hidden; a glass capsule at the right with the changes chip
  (+a −d), terminal toggle, side-panel toggle, more menu.
- **Toasts**: in the title-bar row, centred over the conversation, clear of the
  capsule; at most two; pointing at one pauses its timer; Undo toasts last 8s.
- **Composer**: status row inside the composer while running (hidden while a request
  card shows); pickers: model (provider mark), effort (level glyph; ⚡ glyph in front
  when fast mode is on), permission mode; context ring with its percentage inside,
  opening a card (context window + plan limits); send/stop.
- **Effort popover**: level name (top-left), "⚡ Fast" pill (top-right, only for
  models with fast mode, disabled while busy), then a row of bars, one per level the
  model supports, rising left to right; bars up to the level fill with the accent;
  hover previews; click/drag/arrows/1–5. No descriptions, no default marker. The
  separate Fast/Standard composer button goes away. Settings → General uses the
  same bars, smaller.
- **Request cards** sit in the dock above the composer; at short heights they compact
  (hide the "why" line). Plan card: three quiet actions on the first row (Keep
  planning 4, Save… 6, New worktree… 5), the three approvals right-aligned on a
  second row (Auto mode 3, Approve ask for edits 2, Approve auto-accept edits 1).
- **Rail rows**: status glyph, title, time; "needs you" is an amber dot (not a text
  badge) and its row has no archive button; PR number as a small tag after the
  branch; rows are focusable (Enter/Space opens).
- **Menus**: disabled rows can't be picked; Tab closes and moves on; focus returns to
  the trigger; dialogs trap Tab.
