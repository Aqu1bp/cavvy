// Which dialogs and popovers are open.

import { createSignal } from "solid-js";

export type SettingsTab = "general" | "appearance" | "providers" | "shortcuts" | "about";

export const [paletteOpen, setPaletteOpen] = createSignal(false);
export const [settingsTab, setSettingsTab] = createSignal<SettingsTab | undefined>();
export const [rewindOpen, setRewindOpen] = createSignal(false);
export const [folderPickerOpen, setFolderPickerOpen] = createSignal<{ then: (path: string) => void } | undefined>();
/** Opened from the keyboard or a slash command; the composer's pickers watch these. */
export const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
export const [modePickerOpen, setModePickerOpen] = createSignal(false);
/** Bumped to ask the composer to take focus. */
export const [focusComposer, setFocusComposer] = createSignal(0);
export const requestComposerFocus = () => setFocusComposer((n) => n + 1);
