// The images a call's result brought the model: kept by the session, fetched by their key for the call's row.
import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { IMAGE_KEY, imageKey, keepImages, readKept, toolImagesDir } = await import("../src/server/tool-images");
const { resultImages, resultText } = await import("../src/backends/claude-code");

afterAll(() => iso.cleanup());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("an image is kept once, by a hash of it, and read back by its key", () => {
    const dir = join(tempDir("cavvy-tool-images-"), "tool-images", "s1");
    const image = { type: "image" as const, mediaType: "image/png", data: PNG };
    const keys = keepImages(dir, [image, image, { type: "image", mediaType: "image/svg+xml", data: "PHN2Zz4=" }]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(IMAGE_KEY);
    expect(keys[0]).toBe(imageKey(image)!);
    expect(readdirSync(dir)).toEqual([keys[0]]);
    expect(readKept(dir, keys[0]!)).toEqual({ mediaType: "image/png", data: PNG });
    // Only a key's own shape is read: nothing else in or out of the folder.
    for (const bad of ["../x.png", "a.png", `${keys[0]}/..`, "0".repeat(24) + ".svg"]) expect(readKept(dir, bad)).toBeUndefined();
    expect(readKept(dir, "0".repeat(24) + ".png")).toBeUndefined();
    expect(toolImagesDir("/p/projects/slug/s1.jsonl", "s1")).toBe("/p/projects/slug/tool-images/s1");
});

test("Claude Code's result of an image read: the image as the model saw it, and [image] in its text", () => {
    // As Claude Code's session file records a Read of a PNG.
    const content = [{ type: "image", source: { type: "base64", data: PNG, media_type: "image/png" } }];
    expect(resultImages(content)).toEqual([{ type: "image", mediaType: "image/png", data: PNG }]);
    expect(resultText(content)).toBe("[image]");
    expect(resultImages("text only")).toEqual([]);
    expect(resultImages([{ type: "text", text: "x" }, { type: "image", source: { type: "url", url: "https://example.com/a.png" } }])).toEqual([]);
    expect(existsSync(iso.home)).toBe(true);
});
