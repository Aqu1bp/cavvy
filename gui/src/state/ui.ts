// Which dialogs and popovers are open.

import { createSignal } from "solid-js";
import type { ArchiveOffer } from "@shared/protocol";
import type { ReviewScope } from "./changes";

export type SettingsTab = "general" | "appearance" | "providers" | "usage" | "shortcuts" | "about";

export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [settingsTab, setSettingsTab] = createSignal<SettingsTab | undefined>();
export const [rewindOpen, setRewindOpen] = createSignal(false);
/** The session the delete dialog asks about. */
export const [deleteRequest, setDeleteRequest] = createSignal<{ id: string; title: string; projectName: string } | undefined>();
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
/** The sub-agent the main view shows (an AgentRun id); none for the session itself. */
export const [agentFocus, setAgentFocus] = createSignal<string | undefined>();
/** The review pane docked on the right, and the file (and view) it opens on. */
export const [review, setReview] = createSignal<{ path?: string; scope?: ReviewScope; turnId?: number } | undefined>();
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

/** The find bar over the conversation (⌘F), what it looks for, and a bump to take focus again. */
export const [findOpen, setFindOpen] = createSignal(false);
export const [findQuery, setFindQuery] = createSignal("");
export const [findFocus, setFindFocus] = createSignal(0);
export const openFind = () => (setFindOpen(true), setFindFocus((n) => n + 1));
/** The row holding the match being shown: rows folded around it open for it. */
export const [findReveal, setFindReveal] = createSignal<{ turnId: string; part: string } | undefined>();
/** A message to show once its session is open (a ⌘K hit): where it is, and what was searched. */
export const [jumpTarget, setJumpTarget] = createSignal<{ sessionId: string; seg: number; index: number; role: "user" | "assistant"; query: string } | undefined>();
