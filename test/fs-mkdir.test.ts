// Open a project folder's New folder: fs.mkdir makes one folder, by name, in the folder shown, and never over what's
// already there.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
mkdirSync(iso.home, { recursive: true });

const engine = new Engine({});
const c = { subs: new Set<string>(), send() {} };
engine.clients.add(c);
const call = (method: string, params: unknown) => engine.handle(c, method as never, params);
const root = realpathSync(tempDir("cavvy-mkdir-"));

afterAll(() => engine.clients.delete(c));

test("makes the folder in the one shown and says where it is; the listing then has it", async () => {
    expect(await call("fs.mkdir", { path: root, name: "  new app " })).toEqual({ path: join(root, "new app") });
    expect(statSync(join(root, "new app")).isDirectory()).toBe(true);
    expect(((await call("fs.dirs", { path: root })) as { dirs: string[] }).dirs).toContain("new app");
});

test("never over something already there, and one name only", async () => {
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "file.txt"), "x");
    await expect(call("fs.mkdir", { path: root, name: "taken" })).rejects.toThrow("Something here already has that name.");
    await expect(call("fs.mkdir", { path: root, name: "file.txt" })).rejects.toThrow("Something here already has that name.");
    for (const name of ["a/b", "..", ".", "x\\y"]) await expect(call("fs.mkdir", { path: root, name })).rejects.toThrow("Use a name without slashes.");
    await expect(call("fs.mkdir", { path: root, name: "   " })).rejects.toThrow("Name the folder.");
    expect(existsSync(join(root, "a"))).toBe(false);
});

test("only inside a folder that's there", async () => {
    await expect(call("fs.mkdir", { path: join(root, "nope"), name: "x" })).rejects.toThrow("isn't a folder");
    await expect(call("fs.mkdir", { path: join(root, "file.txt"), name: "x" })).rejects.toThrow("isn't a folder");
});
