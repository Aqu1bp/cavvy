import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

test("streamed activity preserves rows and bounds derivation work", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", "test", fileURLToPath(new URL("./fixtures/gui-activity-motion.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
}, 120_000);

test("activity motion is continuous, compositor friendly and disabled for reduced motion", () => {
    const base = readFileSync(new URL("../gui/src/styles/base.css", import.meta.url), "utf8");
    const transcript = readFileSync(new URL("../gui/src/styles/transcript.css", import.meta.url), "utf8");
    const shimmer = base.slice(base.indexOf("@keyframes shimmer"), base.indexOf(".shimmer svg"));
    expect(shimmer).not.toMatch(/background-position|background-clip/);
    // Steps too small to see: smooth to look at, and the window isn't drawn again on every refresh for it.
    expect(Number(shimmer.match(/steps\((\d+)\)/)?.[1])).toBeGreaterThanOrEqual(30);
    expect(shimmer).toMatch(/opacity:/);
    expect(shimmer).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
    for (const name of ["wkids", "tool-detail", "agl"]) {
        expect(transcript.match(new RegExp(`\\.${name} \\{([^}]+)\\}`))?.[1]).not.toMatch(/animation:/);
    }
});
