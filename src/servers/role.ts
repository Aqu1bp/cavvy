// Whether this machine is one of the user's servers: Cavvy was put on it from another machine (install.ts leaves
// the mark). On a server, sessions start without asking and only what reaches beyond the machine still asks
// (permissions/modes.ts, permissions/bash-safety.ts): a server is there to run agents freely, and can be rebuilt.
// The mark is in the server's own folder, which no agent may write to unasked (permissions/checker.ts), so nothing
// running here can make the user's own computer pass for one.

import { existsSync } from "fs";
import { join } from "path";
import { cavvyHome } from "../config/paths";

/** The mark's name, in the server's folder (remote.ts REMOTE_DIR). */
export const SERVER_MARK = "is-server";

const known = new Map<string, boolean>();

/** Looked at once per home: a machine doesn't become a server under a running Cavvy. */
export function onServer(): boolean {
    const file = join(cavvyHome(), "server", SERVER_MARK);
    let is = known.get(file);
    if (is === undefined) known.set(file, (is = existsSync(file)));
    return is;
}

/** For tests that make a home a server's, or stop it being one. */
export function forgetServerRole() {
    known.clear();
}
