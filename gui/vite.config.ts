import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const shared = fileURLToPath(new URL("../src/server", import.meta.url));

/** lucide-solid's icons drawn from a template (src/lib/lucide-icon.ts), not built anew each time by lucide's Icon. */
const fastIcons = {
    name: "fast-icons",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
        if (source === "../Icon" && importer?.includes("/lucide-solid/dist/source/icons/")) return fileURLToPath(new URL("./src/lib/lucide-icon.ts", import.meta.url));
    },
};

export default defineConfig({
    plugins: [fastIcons, solid()],
    // Match Cavvy's --no-env-file launch policy; builds need no dotenv data.
    envDir: false,
    // Relative URLs: the same build loads from the desktop app (tauri://) and from `cavvy gui` (http://).
    base: "./",
    resolve: { alias: { "@shared": shared } },
    clearScreen: false,
    worker: { format: "es" },
    server: {
        port: 5173,
        strictPort: true,
        fs: { allow: [".", shared, fileURLToPath(new URL("../src/util/secret-patterns.ts", import.meta.url))] },
    },
    build: {
        // WebKit (macOS, Linux) and WebView2: modern, but not bleeding edge.
        target: ["es2022", "safari16", "chrome111"],
        outDir: "dist",
        emptyOutDir: true,
        sourcemap: false,
        chunkSizeWarningLimit: 900,
        assetsInlineLimit: 0,
    },
});
