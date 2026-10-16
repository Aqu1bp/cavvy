// Which dialogs and popovers are open.

import { createSignal } from "solid-js";
import type { ReviewScope } from "./changes";

export type SettingsTab = "general" | "appearance" | "providers" | "shortcuts" | "about";

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
/** The sub-agent the main view shows (an AgentRun id); none for the session itself. */
export const [agentFocus, setAgentFocus] = createSignal<string | undefined>();
/** The review pane docked on the right, and the file (and view) it opens on. */
export const [review, setReview] = createSignal<{ path?: string; scope?: ReviewScope; turnId?: number } | undefined>();
/** Bumped to ask the composer to take focus. */
export const [focusComposer, setFocusComposer] = createSignal(0);
export const requestComposerFocus = () => setFocusComposer((n) => n + 1);

/** Bottom panel; hiding it keeps its shells running. */
export const [terminalOpen, setTerminalOpen] = createSignal(false);

/** Set while the terminal panel is mounted: opens it on a new tab that runs a project script there. */
export const terminalActions: { runScript?: (cwd: string, script: { id: string; name: string }) => void } = {};
