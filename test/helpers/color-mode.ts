// src/ui/ansi.ts decides colorEnabled once, at import time (NO_COLOR /
// FORCE_COLOR / stdout.isTTY), and bun test shares one module registry across
// files. So a single run only ever exercises one color mode. The UI tests call
// alsoRunInOtherColorMode() to re-run their own file in a child process with
// the opposite mode, so both the plain and the styled code paths are covered
// no matter where the tests run.
//
// Tests that assert intended behavior for a known bug use bugTest(); the child
// run skips them so a known failure is reported once, not twice.

import { test } from "bun:test";
import { resolve } from "path";
import { colorEnabled } from "../../src/ui/ansi";

const CHILD = "CAVVY_TEST_COLOR_CHILD";
const ROOT = resolve(import.meta.dir, "../..");

export const isColorChild = Boolean(process.env[CHILD]);

/** A test for intended behavior that currently fails because of a suspected bug. */
export const bugTest: typeof test = isColorChild ? (test.skip as typeof test) : test;

export function alsoRunInOtherColorMode(file: string): void {
    if (isColorChild) return;
    const mode = colorEnabled ? "disabled" : "enabled";
    test(`whole file also passes with colors ${mode} (child process)`, () => {
        const env: Record<string, string | undefined> = { ...process.env, [CHILD]: "1" };
        if (colorEnabled) {
            env.NO_COLOR = "1";
            delete env.FORCE_COLOR;
        } else {
            env.FORCE_COLOR = "1";
            delete env.NO_COLOR;
        }
        const r = Bun.spawnSync([process.execPath, "--no-env-file", "test", file], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) {
            throw new Error(`child run with colors ${mode} failed (exit ${r.exitCode}):\n${r.stdout.toString()}${r.stderr.toString()}`);
        }
    }, 60_000);
}
