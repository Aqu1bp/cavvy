// What Home shows under and around the composer for a folder (whether it's trusted, its terminal conversations),
// asked for before Home goes to that folder on a machine, so Home changes once, with them in, rather than showing
// without them and then moving as each arrives. Kept for the window's life: going back to a machine shows its folder
// at once, and is asked for again behind it.

import type { CliSessionsList, ProjectInfo } from "@shared/protocol";
import type { Rpc } from "../lib/rpc";

/** By machine (undefined the window's own; "" this computer, in a window on a server) and folder. */
const key = (on: string | undefined, path: string) => `${on === undefined ? "" : `@${on}`}\0${path}`;
const inspects = new Map<string, ProjectInfo>();
const clis = new Map<string, CliSessionsList>();

/** What `projects.inspect` said of that folder last, if it's been asked. */
export const inspectedBefore = (on: string | undefined, path: string) => inspects.get(key(on, path));
/** The terminal conversations listed for that folder last (on the window's own machine). */
export const cliListedBefore = (path: string) => clis.get(path);

export function inspect(link: Rpc, on: string | undefined, path: string): Promise<ProjectInfo> {
    return link.call("projects.inspect", { path }).then((r) => (inspects.set(key(on, path), r), r));
}

export function listCli(link: Rpc, path: string): Promise<CliSessionsList> {
    return link.call("cliSessions.list", { cwd: path }).then((r) => (clis.set(path, r), r));
}

/** Trusting or not changes what inspect says: not shown from before. */
export function forgetInspected(on: string | undefined, path: string) {
    inspects.delete(key(on, path));
}
