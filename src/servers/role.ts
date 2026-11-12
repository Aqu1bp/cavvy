// Whether this Cavvy is one of the user's servers': the program that's running is the one another machine put
// there (`cavvy servers add`: ~/.cavvy/server/builds/<build>/cavvy, which the server's service and every
// `cavvy --server` run start). On a server, sessions start without asking and only what reaches beyond the machine
// still asks (permissions/modes.ts, permissions/bash-safety.ts): a server is there to run agents freely, and can be
// rebuilt.
//
// It's read from where the running program is, not from a file or a setting: those an agent working on the user's
// own computer could write, and that computer's Cavvy (the desktop app, a checkout, an installed program) never
// runs from a server's install. Changing that would take replacing the program the user starts, which is past
// anything asking about commands can guard.

import { lstatSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, sep } from "path";

const real = (p: string) => {
    try {
        return realpathSync(p);
    } catch {
        return undefined;
    }
};

/** A folder that is one, not a link to one: a link could name any folder as the server's install. */
const folder = (p: string) => {
    try {
        return lstatSync(p).isDirectory();
    } catch {
        return false;
    }
};

/**
 * Whether `program` is in the server install under `home`: under <home>/.cavvy/server/builds, each of those a folder
 * of its own. The program may be reached through links (the service runs `current/cavvy`); the install may not.
 */
export function inServerInstall(program: string, home: string): boolean {
    const base = real(home);
    const p = real(program);
    if (base === undefined || p === undefined) return false;
    let at = base;
    for (const part of [".cavvy", "server", "builds"]) {
        at = join(at, part);
        if (!folder(at)) return false;
    }
    return p.startsWith(at + sep);
}

let known: boolean | undefined;

export function onServer(): boolean {
    if (known !== undefined) return known;
    // Run from source, the program is Bun whatever started it: the tests' pretend server says which program it
    // stands for (test/helpers/fake-ssh.ts). A compiled Cavvy, which is what everyone else runs, is asked nothing,
    // and is a server's only on Linux, the one system a server's build is made for.
    const fromSource = /(^|[/\\])bun(\.exe)?$/.test(process.execPath);
    const program = fromSource ? process.env.CAVVY_SERVER_PROGRAM : process.platform === "linux" ? process.execPath : undefined;
    return (known = Boolean(program) && inServerInstall(program!, homedir()));
}

/** For tests that change what the answer rests on. */
export function forgetServerRole() {
    known = undefined;
}
