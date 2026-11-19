import { defineConfig, minifySync, type Plugin } from "vite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const shared = fileURLToPath(new URL("../src/server", import.meta.url));

/** public/theme-boot.js runs before the first paint, as written, so it's copied as it is: minified here, it's fetched and parsed in half the bytes. */
function minifyBoot(): Plugin {
    let outDir = "";
    return {
        name: "minify-theme-boot",
        apply: "build",
        configResolved: (c) => void (outDir = c.build.outDir),
        closeBundle() {
            const file = join(outDir, "theme-boot.js");
            const { code, errors } = minifySync("theme-boot.js", readFileSync(file, "utf8"), { compress: true, mangle: true });
            if (errors.length) throw new Error(`theme-boot.js: ${errors[0]!.message}`);
            writeFileSync(file, code);
        },
    };
}

/** lucide-solid's icons drawn from a template (src/lib/lucide-icon.ts), not built anew each time by lucide's Icon. */
const fastIcons = {
    name: "fast-icons",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
        if (source === "../Icon" && importer?.includes("/lucide-solid/dist/source/icons/")) return fileURLToPath(new URL("./src/lib/lucide-icon.ts", import.meta.url));
    },
};

export default defineConfig({
    plugins: [fastIcons, solid(), minifyBoot()],
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
