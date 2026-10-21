// Every action a key can be bound to, in Claude Code's names where it has
// one. An action belongs to one app or both; the other app ignores it, so a
// key bound to a GUI-only action keeps its meaning in the terminal.

export const CONTEXTS = ["Global", "Chat", "Autocomplete"] as const;
export type Context = (typeof CONTEXTS)[number];

export type KeyApp = "tui" | "gui";

export interface ActionDef {
    id: string;
    context: Context;
    description: string;
    /** Default keys per app; an app missing here doesn't have the action. `mod` is Cmd on macOS, Ctrl elsewhere. */
    defaults: Partial<Record<KeyApp, string[]>>;
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
    { id: "chat:submitOtherWay", context: "Global", description: "While a turn runs: send the other way (steer or queue)", defaults: { tui: ["tab"], gui: ["mod+shift+enter"] } },
    // Chat (the input box)
    { id: "chat:submit", context: "Chat", description: "Send", defaults: { tui: ["enter"], gui: ["enter", "mod+enter"] } },
    { id: "chat:newline", context: "Chat", description: "New line", defaults: { tui: ["shift+enter", "alt+enter", "ctrl+j"], gui: ["shift+enter", "alt+enter"] } },
    { id: "chat:cancel", context: "Chat", description: "Interrupt · press twice to clear the input or rewind", defaults: { tui: ["escape"] } },
    { id: "chat:cycleMode", context: "Chat", description: "Cycle permission mode", defaults: { tui: ["shift+tab"], gui: ["shift+tab"] } },
    { id: "chat:externalEditor", context: "Chat", description: "Edit the prompt in $EDITOR", defaults: { tui: ["ctrl+g"] } },
    { id: "chat:imagePaste", context: "Chat", description: "Paste an image from the clipboard", defaults: { tui: ["ctrl+v"] } },
    { id: "chat:undo", context: "Chat", description: "Undo the last edit", defaults: { tui: ["ctrl+_", "ctrl+-"] } },
    { id: "history:previous", context: "Chat", description: "Previous prompt", defaults: { tui: ["up", "ctrl+p"], gui: ["up"] } },
    { id: "history:next", context: "Chat", description: "Next prompt", defaults: { tui: ["down", "ctrl+n"], gui: ["down"] } },
    // Autocomplete (the / and @ menu)
    { id: "autocomplete:accept", context: "Autocomplete", description: "Accept the suggestion", defaults: { tui: ["tab"], gui: ["tab"] } },
    { id: "autocomplete:dismiss", context: "Autocomplete", description: "Close the suggestions", defaults: { tui: ["escape"], gui: ["escape"] } },
    { id: "autocomplete:previous", context: "Autocomplete", description: "Previous suggestion", defaults: { tui: ["up"], gui: ["up"] } },
    { id: "autocomplete:next", context: "Autocomplete", description: "Next suggestion", defaults: { tui: ["down"], gui: ["down"] } },
];

export const ACTION_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.id, a]));
