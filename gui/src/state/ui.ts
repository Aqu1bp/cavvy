// Which dialogs and popovers are open.

import { createSignal } from "solid-js";
import type { ArchiveOffer } from "@shared/protocol";

export type SettingsTab = "general" | "appearance" | "providers" | "shortcuts" | "about";

export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [settingsTab, setSettingsTab] = createSignal<SettingsTab | undefined>();
export const [rewindOpen, setRewindOpen] = createSignal(false);
/** The browser's folder picker; `then` gets undefined when it's cancelled. */
export const [folderPickerOpen, setFolderPickerOpen] = createSignal<{ then: (path: string | undefined) => void; title?: string; action?: string; start?: string } | undefined>();
/** Opened from the keyboard or a slash command; the composer's pickers watch these. */
export const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
export const [modePickerOpen, setModePickerOpen] = createSignal(false);
/** The sub-agent the main view shows (an AgentRun id); none for the session itself. */
export const [agentFocus, setAgentFocus] = createSignal<string | undefined>();
/** The review pane docked on the right, and the file it shows. */
export const [review, setReview] = createSignal<{ path?: string } | undefined>();
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
