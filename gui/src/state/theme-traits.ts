// What Settings needs to know of the theme showing (state/theme.ts sets it): kept here so Settings doesn't load the
// theme code, and the window's first load carries none of it.

import { createSignal } from "solid-js";

export const [themeTraits, setThemeTraits] = createSignal<{ name: string; scened: boolean; accent: boolean } | undefined>(undefined);
