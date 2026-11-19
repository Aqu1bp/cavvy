// The themes Cavvy comes with. Each is drawn by code and loaded only when it's shown or listed, so the window's
// first load carries none of them.

import type { Scheme, Theme } from "../format";

export interface BuiltinTheme {
    id: string;
    name: string;
    /** The kinds of window it has a look for. */
    schemes: Scheme[];
    load(): Promise<Theme>;
}

export const BUILTINS: BuiltinTheme[] = [
    { id: "bloom", name: "Bloom", schemes: ["light", "dark"], load: () => import("./bloom").then((m) => m.bloom()) },
    { id: "komorebi", name: "Komorebi", schemes: ["light"], load: () => import("./komorebi").then((m) => m.komorebi()) },
    { id: "meadow", name: "Meadow", schemes: ["light"], load: () => import("./meadow").then((m) => m.meadow()) },
    { id: "night-rain", name: "Night Rain", schemes: ["dark"], load: () => import("./night-rain").then((m) => m.nightRain()) },
    { id: "fireflies", name: "Fireflies", schemes: ["dark"], load: () => import("./fireflies").then((m) => m.fireflies()) },
    { id: "orbit", name: "Orbit", schemes: ["dark"], load: () => import("./orbit").then((m) => m.orbit()) },
    { id: "glowworms", name: "Glowworms", schemes: ["dark"], load: () => import("./glowworms").then((m) => m.glowworms()) },
];

export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((b) => b.id));

export const builtin = (id: string) => BUILTINS.find((b) => b.id === id);
