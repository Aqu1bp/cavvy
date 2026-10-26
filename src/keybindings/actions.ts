// Every action a key can be bound to, in Claude Code's names where it has
// one. An action belongs to one app or both; the other app ignores it, so a
// key bound to a GUI-only action keeps its meaning in the terminal.

export const CONTEXTS = ["Global", "Chat", "Autocomplete", "Sidebar"] as const;
export type Context = (typeof CONTEXTS)[number];

/**
 * Where a key is looked up while a context is in force, most specific first:
 * the / and @ menu over the input box over the whole window; the session list
 * (the GUI's rail, while it has the focus) over the whole window.
 */
export const CONTEXT_CHAIN: Readonly<Record<Context, readonly Context[]>> = {
    Global: ["Global"],
    Chat: ["Chat", "Global"],
    Autocomplete: ["Autocomplete", "Chat", "Global"],
    Sidebar: ["Sidebar", "Global"],
};

/** The contexts a binding of an action may be put in (a Global one also works where a more specific context applies). */
export function contextsFor(def: ActionDef): readonly Context[] {
    if (def.context === "Global") return ["Global", "Chat", "Sidebar"];
    if (def.context === "Chat") return ["Global", "Chat"];
    return [def.context];
}

export type KeyApp = "tui" | "gui";

export interface ActionDef {
    id: string;
    context: Context;
    description: string;
    /** Default keys per app; an app missing here doesn't have the action. `mod` is Cmd on macOS, Ctrl elsewhere. */
    defaults: Partial<Record<KeyApp, string[]>>;
    /** A Global action that only acts in the input box, where Chat's keys come first. */
    inInput?: boolean;
    /** The GUI's default keys on macOS, where they differ from `defaults.gui`. */
    macGui?: string[];
}

export const ACTIONS: readonly ActionDef[] = [
    // Global
    { id: "app:commandPalette", context: "Global", description: "Search sessions, messages and actions", defaults: { gui: ["mod+k"] } },
    { id: "app:newSession", context: "Global", description: "New session", defaults: { gui: ["mod+n"] } },
    { id: "app:find", context: "Global", description: "Find in the conversation", defaults: { gui: ["mod+f"] } },
    { id: "app:settings", context: "Global", description: "Settings", defaults: { gui: ["mod+,"] } },
    { id: "app:toggleSidebar", context: "Global", description: "Toggle the sidebar", defaults: { gui: ["mod+b"] } },
    { id: "app:togglePanel", context: "Global", description: "Toggle the side panel", defaults: { gui: ["mod+."] } },
    { id: "app:previousSession", context: "Global", description: "Previous session", defaults: { gui: ["mod+[", "mod+alt+up"] } },
    { id: "app:nextSession", context: "Global", description: "Next session", defaults: { gui: ["mod+]", "mod+alt+down"] } },
    { id: "app:toggleTerminal", context: "Global", description: "Toggle the terminal", defaults: { gui: ["ctrl+`", "mod+`"] } },
    { id: "app:interrupt", context: "Global", description: "Interrupt the turn (while working)", defaults: { gui: ["escape"] } },
    { id: "app:toggleTodos", context: "Global", description: "Show or hide the todo list", defaults: { tui: ["ctrl+t"] } },
    { id: "app:toggleTranscript", context: "Global", description: "Verbose output on or off", defaults: { tui: ["ctrl+o"] } },
    { id: "app:redraw", context: "Global", description: "Clear and redraw the screen", defaults: { tui: ["ctrl+l"] } },
    { id: "chat:modelPicker", context: "Global", description: "Switch model", defaults: { gui: ["mod+/"] } },
    { id: "chat:focusInput", context: "Global", description: "Focus the input box", defaults: { gui: ["mod+l"] } },
    // Global, like the shortcut it replaced: any binding of its key, in any context, takes the key from it.
    { id: "chat:submitOtherWay", context: "Global", description: "While a turn runs: send the other way (steer or queue)", defaults: { tui: ["tab"], gui: ["mod+shift+enter"] }, inInput: true },
    // Chat (the input box)
    { id: "chat:submit", context: "Chat", description: "Send", defaults: { tui: ["enter"], gui: ["enter", "mod+enter"] } },
    { id: "chat:newline", context: "Chat", description: "New line", defaults: { tui: ["shift+enter", "alt+enter", "ctrl+j"], gui: ["shift+enter", "alt+enter"] } },
    { id: "chat:cancel", context: "Chat", description: "Interrupt · press twice to clear the input or rewind", defaults: { tui: ["escape"] } },
    { id: "chat:cycleMode", context: "Chat", description: "Cycle permission mode", defaults: { tui: ["shift+tab"], gui: ["shift+tab"] } },
    { id: "chat:externalEditor", context: "Chat", description: "Edit the prompt in $EDITOR", defaults: { tui: ["ctrl+g"] } },
    { id: "chat:expand", context: "Chat", description: "Make the input box large, or back to its size", defaults: { gui: ["mod+shift+e"] } },
    { id: "chat:imagePaste", context: "Chat", description: "Paste an image from the clipboard", defaults: { tui: ["ctrl+v"] } },
    { id: "chat:undo", context: "Chat", description: "Undo the last edit", defaults: { tui: ["ctrl+_", "ctrl+-"] } },
    { id: "history:previous", context: "Chat", description: "Previous prompt", defaults: { tui: ["up", "ctrl+p"], gui: ["up"] } },
    { id: "history:next", context: "Chat", description: "Next prompt", defaults: { tui: ["down", "ctrl+n"], gui: ["down"] } },
    // Autocomplete (the / and @ menu)
    { id: "autocomplete:accept", context: "Autocomplete", description: "Accept the suggestion", defaults: { tui: ["tab"], gui: ["tab"] } },
    { id: "autocomplete:dismiss", context: "Autocomplete", description: "Close the suggestions", defaults: { tui: ["escape"], gui: ["escape"] } },
    { id: "autocomplete:previous", context: "Autocomplete", description: "Previous suggestion", defaults: { tui: ["up"], gui: ["up"] } },
    { id: "autocomplete:next", context: "Autocomplete", description: "Next suggestion", defaults: { tui: ["down"], gui: ["down"] } },
    // Sidebar (the GUI's session list, while it has the focus). With no rows selected they act on the focused or open one.
    // Delete: Finder's ⌘⌫ on a Mac, Explorer's Delete elsewhere; plain Backspace is left alone (a stray one shouldn't ask to delete).
    { id: "sidebar:deleteSelected", context: "Sidebar", description: "Delete the selected sessions", defaults: { gui: ["delete"] }, macGui: ["mod+backspace"] },
    { id: "sidebar:settleSelected", context: "Sidebar", description: "Settle the selected sessions (or bring settled ones back)", defaults: { gui: ["mod+shift+s"] } },
    { id: "sidebar:archiveSelected", context: "Sidebar", description: "Archive the selected sessions (or restore archived ones)", defaults: { gui: ["mod+shift+a"] } },
    { id: "sidebar:selectAll", context: "Sidebar", description: "Select every session in the list", defaults: { gui: ["mod+a"] } },
];

export const ACTION_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.id, a]));
