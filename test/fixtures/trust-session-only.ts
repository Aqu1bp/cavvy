// Runs in a child process so the session-wide trust it grants (home, "/")
// can't leak into other tests. Prints a JSON report on stdout.

import { existsSync, readFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

const home = process.env.CAVVY_HOME;
if (!home || !resolve(home).startsWith(resolve(tmpdir()))) {
    console.error("CAVVY_HOME must point into the temp dir");
    process.exit(2);
}

const { isTrusted, trustFolder } = await import("../../src/config/trust");
const file = join(home, "trusted.json");
const read = () => (existsSync(file) ? readFileSync(file, "utf-8") : null);

const elsewhere = join(tmpdir(), "cavvy-trust-elsewhere");
const report: Record<string, unknown> = {
    before: { home: isTrusted(homedir()), elsewhere: isTrusted(elsewhere) },
};
trustFolder(homedir());
report.afterHome = { home: isTrusted(homedir()), homeChild: isTrusted(join(homedir(), "some", "project")), elsewhere: isTrusted(elsewhere), file: read() };
trustFolder("/");
report.afterRoot = { elsewhere: isTrusted(elsewhere), file: read() };
console.log(JSON.stringify(report));
