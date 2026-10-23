// Which dialogs and popovers are open, and how the window is laid out.

import { createSignal } from "solid-js";
import type { ArchiveOffer } from "@shared/protocol";
import type { ReviewScope } from "./changes";
import { coversConversation, INSPECTOR_DEFAULT, type Held, type WindowLayout } from "../lib/layout";
import type { InspectorPane } from "../lib/inspector";

export type SettingsTab = "general" | "appearance" | "providers" | "plugins" | "usage" | "shortcuts" | "about";

export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [settingsTab, setSettingsTab] = createSignal<SettingsTab | undefined>();
/** "Add account…" in the model picker: the CLI provider whose new-account form Settings → Providers opens. */
export const [addAccountFor, setAddAccountFor] = createSignal<string | undefined>();
export const [rewindOpen, setRewindOpen] = createSignal(false);
/** What the delete dialog asks about: one session (with its project), or several picked in the rail. */
export type DeleteRequest = { id: string; title: string; projectName: string } | { ids: string[]; titles: string[] };
export const [deleteRequest, setDeleteRequest] = createSignal<DeleteRequest | undefined>();
/**
 * An image the viewer can show. `full`: the whole image, as a URL that's cheap
 * to set (an object URL, or a small data: URL), or as base64 it makes an object
 * URL of. `preview`: already decoded (a thumbnail, or the transcript's own),
 * shown at once and until `full` is. `size`: its pixels, where they're known.
 */
export type ViewerImage = { name: string; full: string | { mediaType: string; data: string }; preview?: string; size?: { width: number; height: number } };
/** The image shown full size over everything, the others it steps to (a prompt's, a reply's, the composer's), and what it was opened from. */
export const [viewedImage, setViewedImage] = createSignal<{ images: ViewerImage[]; index: number; from?: Element } | undefined>();
/** Files checked in the review pane when Commit was clicked. */
export const [commitRequest, setCommitRequest] = createSignal<{ id: string; paths: string[] } | undefined>();
/** The browser's folder picker; `then` gets undefined when it's cancelled. */
export const [folderPickerOpen, setFolderPickerOpen] = createSignal<{ then: (path: string | undefined) => void; title?: string; action?: string; start?: string } | undefined>();
/** The MCP servers dialog, and the server to show first. */
export const [mcpOpen, setMcpOpen] = createSignal<{ focus?: string } | undefined>();
/** Opened from the keyboard or a slash command; the composer's pickers watch these. */
export const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
export const [modePickerOpen, setModePickerOpen] = createSignal(false);
/** The composer's context card (/context opens it). */
export const [contextCardOpen, setContextCardOpen] = createSignal(false);
/** Setup must be visible; an overlay opened during checkout leaves it for a manual run. */
export const setupObscured = () => Boolean(settingsTab() || paletteOpen() || rewindOpen() || deleteRequest() || commitRequest() || folderPickerOpen() || mcpOpen() || modelPickerOpen() || modePickerOpen() || contextCardOpen());
/** The side panel's tab; kept while the app runs, like the reader's layout. */
export const [inspectorPane, setInspectorPane] = createSignal<InspectorPane>("changes");
/** The sub-agent the main view shows (an AgentRun id); none for the session itself. */
export const [agentFocus, setAgentFocus] = createSignal<string | undefined>();
/** The review pane docked on the right, and the file (and view) it opens on. */
/** `token`: the file's handle when its name was shown redacted (GitFileDiff.pathToken); `path` stays the name shown. */
export const [review, setReview] = createSignal<{ path?: string; token?: string; scope?: ReviewScope; turnId?: number } | undefined>();
/** Bumped to ask the composer to take focus. */
export const [focusComposer, setFocusComposer] = createSignal(0);
export const requestComposerFocus = () => setFocusComposer((n) => n + 1);

/**
 * A plan of a session's, open in a dialog: to read it, save it, or carry it out
 * in a new worktree. `planId` is PlanInfo.id (the latest plan when omitted).
 */
export const [planDialog, setPlanDialog] = createSignal<{ kind: "view" | "save" | "worktree"; sessionId: string; planId?: string } | undefined>();
/** Archiving a session that works in a managed worktree: whether to remove the worktree too. */
export const [archiveRequest, setArchiveRequest] = createSignal<{ id: string; title: string; offer: ArchiveOffer } | undefined>();

/** Bottom panel; hiding it keeps its shells running. */
export const [terminalOpen, setTerminalOpen] = createSignal(false);

/** The models Home's next prompt goes to, each in a worktree of its own (Compare in the model picker); undefined while that's off. */
export const [comparePicks, setComparePicks] = createSignal<string[] | undefined>();
/** A worktree's setup run: the server's single-use ticket, the tab's name, and the command for its tooltip. */
export interface SetupRun { ticket: string; label: string; command: string }

/** Set while the terminal panel is mounted: opens it on a new tab that runs a project script there (`setup`: a new worktree's setup run). */
export const terminalActions: { loginAccount?: (provider: string, accountId: string, name: string) => void; runScript?: (cwd: string, script: { id: string; name: string }, setup?: SetupRun) => void } = {};

/**
 * The find bar over the conversation (⌘F), what it looks for, and a bump to take focus again. Opening it
 * (and a ⌘K jump to a message, which opens it) closes a diff reader filling the sheet over the conversation.
 */
export const [findOpen, setFindOpen] = createSignal(false);
export const [findQuery, setFindQuery] = createSignal("");
export const [findFocus, setFindFocus] = createSignal(0);
export const openFind = () => {
    if (coversConversation(shellLayout())) setReview(undefined);
    setFindOpen(true);
    setFindFocus((n) => n + 1);
};
/** The row holding the match being shown: rows folded around it open for it. */
export const [findReveal, setFindReveal] = createSignal<{ turnId: string; part: string } | undefined>();
/** A message to show once its session is open (a ⌘K hit): where it is, and what was searched. */
export const [jumpTarget, setJumpTarget] = createSignal<{ sessionId: string; seg: number; index: number; role: "user" | "assistant"; query: string } | undefined>();

/** The rail's drawer, open over the sheet in narrow windows (lib/layout.ts: below 900px the rail doesn't dock). */
export const [railOpen, setRailOpen] = createSignal(false);
/** The terminal fills the whole sheet (the conversation and inspector wait behind it). */
export const [terminalMax, setTerminalMax] = createSignal(false);
/** The terminal panel is showing (open, and with a tab for this project), as the panel decides. */
export const [terminalShown, setTerminalShown] = createSignal(false);
/** The composer dock's height, requests included: a floating inspector ends above it. */
export const [dockHeight, setDockHeight] = createSignal(0);
/** Until when the dock's next change of height is the composer opening or closing its large size: the conversation glides with it. */
let dockGlideUntil = -Infinity;
/** The composer is about to open or close its large size (Composer.tsx). */
export const glideDock = () => { dockGlideUntil = performance.now() + 100; };
/** The dock's change of height is the composer's large size opening or closing, once (Transcript.tsx). */
export const takeDockGlide = () => {
    const glides = performance.now() < dockGlideUntil;
    dockGlideUntil = -Infinity;
    return glides;
};
/** The diff reader shows changes side by side: the inspector widens further for it. */
export const [reviewSplit, setReviewSplit] = createSignal(false);
/** The inspector's width (its resizer), when it isn't the diff reader. */
export const [inspectorWidth, setInspectorWidth] = createSignal(INSPECTOR_DEFAULT);

/**
 * Sizes being dragged (lib/drag.ts), shown until the release saves them to the preferences (or
 * to inspectorWidth): the rail's width, the inspector's, the diff reader's, the terminal's height.
 */
export const [railDrag, setRailDrag] = createSignal<number>();
export const [inspectorDrag, setInspectorDrag] = createSignal<number>();
export const [reviewDrag, setReviewDrag] = createSignal<number>();
export const [terminalDrag, setTerminalDrag] = createSignal<number>();

/** Where the title bar's title starts and its tools end (from the window's left and right edges), and its top: the toasts drop into that row. */
export interface TitleBarBox { start: number; end: number; top: number }
export const [titleBarBox, setTitleBarBox] = createSignal<TitleBarBox | undefined>(undefined, {
    equals: (a, b) => a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.top === b.top),
});

/** The window's layout, kept by the shell (App.tsx) from lib/layout.ts's rules. */
export const [shellLayout, setShellLayout] = createSignal<WindowLayout>({
    railMode: "dock",
    railShown: true,
    sheet: { w: 0, h: 0 },
    column: { w: 0, h: 0 },
    inspector: { open: false, mode: "dock", width: INSPECTOR_DEFAULT, short: false, bottom: 0 },
    terminal: { shown: false, height: 0, maximized: false, most: 0 },
});

/** The sizes held while the panels slide open or shut (lib/layout.ts heldSizes), and the slide; undefined at rest. */
export const [panelHold, setPanelHold] = createSignal<Held & { slide: Animation }>();

/**
 * The conversation column's height as --column-h, for the few boxes sized by it (what `cqh` measured when
 * the column was a query container: shell.css). Set on each of them, not inherited from the column.
 */
export const columnHeight = () => (shellLayout().column.h ? `${shellLayout().column.h}px` : undefined);
