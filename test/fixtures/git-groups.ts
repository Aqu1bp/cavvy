// An async git call that never ends by itself (the test's fake git), and the harness then ending: by exit, or a signal.
import { existsSync } from "node:fs";
import { join } from "node:path";
const { gitAsync } = await import("../../src/util/git");
const [dir, end] = process.argv.slice(2) as [string, string];
void gitAsync(dir, ["log"], { timeoutMs: 60_000 });
while (!existsSync(join(dir, ".git", "pids"))) await Bun.sleep(10);
if (end === "exit") process.exit(0);
// Waits for the test's signal.
setInterval(() => {}, 1000);
