// Which Mac apps an agent may never be given (src/desktop): a terminal runs anything, a password manager holds every
// secret, and Cavvy is where the person watches and stops the agent. They're refused by name before anyone is asked,
// and by bundle id once the name is found to be an app.

export type NeverReason = "terminal" | "credentials" | "cavvy";

export interface NeverOfferedApp {
    bundleId: string;
    name: string;
    reason: NeverReason;
}

/**
 * The apps never offered, by bundle id: what a computer-use tool of another agent (Codex's bundle id deny list) can
 * be told too. Apps not listed are caught by their names (neverOffered); Cavvy by any bundle id of its own (dev.cavvy…).
 */
export const NEVER_OFFERED: readonly NeverOfferedApp[] = [
    ...(
        [
            ["com.apple.Terminal", "Terminal"],
            ["com.googlecode.iterm2", "iTerm2"],
            ["com.mitchellh.ghostty", "Ghostty"],
            ["dev.warp.Warp-Stable", "Warp"],
            ["dev.warp.Warp", "Warp"],
            ["dev.warp.Warp-Preview", "Warp Preview"],
            ["com.github.wez.wezterm", "WezTerm"],
            ["org.alacritty", "Alacritty"],
            ["io.alacritty", "Alacritty"],
            ["net.kovidgoyal.kitty", "kitty"],
            ["co.zeit.hyper", "Hyper"],
            ["org.tabby", "Tabby"],
            ["com.raphaelamorim.rio", "Rio"],
            ["com.termius-dmg.mac", "Termius"],
            ["dev.commandline.waveterm", "Wave"],
            ["com.panic.Prompt3", "Prompt 3"],
        ] as const
    ).map(([bundleId, name]) => ({ bundleId, name, reason: "terminal" as const })),
    ...(
        [
            ["com.apple.Passwords", "Passwords"],
            ["com.apple.keychainaccess", "Keychain Access"],
            ["com.1password.1password", "1Password"],
            ["com.agilebits.onepassword7", "1Password 7"],
            ["com.agilebits.onepassword-osx", "1Password"],
            ["com.bitwarden.desktop", "Bitwarden"],
            ["org.keepassxc.keepassxc", "KeePassXC"],
            ["com.lastpass.LastPass", "LastPass"],
            ["com.dashlane.dashlanephonefinal", "Dashlane"],
            ["com.dashlane.Dashlane", "Dashlane"],
            ["in.sinew.Enpass-Desktop", "Enpass"],
            ["com.nordpass.macos.NordPass", "NordPass"],
            ["com.keepersecurity.passwordmanager", "Keeper"],
            ["me.proton.pass.electron", "Proton Pass"],
            ["com.authy.authy-mac", "Authy"],
        ] as const
    ).map(([bundleId, name]) => ({ bundleId, name, reason: "credentials" as const })),
    { bundleId: "dev.cavvy.desktop", name: "Cavvy", reason: "cavvy" },
];

const BY_ID = new Map(NEVER_OFFERED.map((a) => [a.bundleId.toLowerCase(), a.reason]));

/** Their names, whole, and words that say what an app is (a terminal or password manager not listed above). */
const TERMINAL_NAME = /^(terminal|iterm ?2?|ghostty|warp|wezterm|alacritty|kitty|hyper|tabby|rio|termius|wave( terminal)?|prompt ?3?)$|\bterm(inal)?\b/i;
const CREDENTIAL_NAME = /^(keychain access|1password( \d+)?|bitwarden|keepassxc|lastpass|dashlane|enpass|nordpass|keeper( password manager)?|proton pass|authy( desktop)?)$|\b(passwords?|keychain)\b/i;
const CAVVY_NAME = /^\s*cavvy\b/i;

const plain = (name: string) => name.trim().replace(/\.app\/?$/i, "").replace(/^.*\//, "");

/**
 * Why an app is never offered, if it isn't: by its bundle id when it's known, else by its name. `own`: it's one of
 * the processes Cavvy runs in (Cavvy itself, whatever its build is called, and the terminal `cavvy` runs in).
 */
export function neverOffered(app: { name: string; bundleId?: string; own?: boolean }): NeverReason | undefined {
    const id = app.bundleId?.toLowerCase();
    const name = plain(app.name);
    if (app.own || id?.startsWith("dev.cavvy") || CAVVY_NAME.test(name)) return "cavvy";
    const listed = id ? BY_ID.get(id) : undefined;
    if (listed) return listed;
    if (TERMINAL_NAME.test(name)) return "terminal";
    if (CREDENTIAL_NAME.test(name)) return "credentials";
    // A bundle id given as the name.
    if (!id && /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(name)) return neverOffered({ name: "", bundleId: name });
    return undefined;
}

/** What the agent is told when it asks for one of them. */
export function neverOfferedMessage(name: string, why: NeverReason): string {
    const what = why === "terminal" ? "a terminal" : why === "credentials" ? "a password manager" : "Cavvy itself";
    return `${plain(name) || name} can't be used: it's ${what}. Terminals, password managers and Cavvy are never offered.`;
}
