// The setup script: the one project script the user marks to run in each
// worktree they create from the GUI (`bun install`, say). It runs without a
// click of its own, so the server decides, not the window: creating the
// worktree hands the window that asked a ticket for that one run, and a start
// without a good ticket is refused. The ticket is single-use, short-lived,
// bound to the connection, the new worktree and the script as it was marked,
// so a reload, a reconnect, another window, a second try or a changed script
// never runs it. Tickets live only here, in memory, and are never logged.

import { randomBytes } from "crypto";
import { realpathSync, statSync } from "fs";
import { resolve } from "path";
import { trustedByUser } from "../config/trust";
import { RpcError } from "./rpc-error";
import type { ProjectScript } from "./protocol";

/** Long enough for the window to open the project and a tab; too short to come back to later. */
export const SETUP_TTL_MS = 2 * 60_000;
/** Each worktree created from the GUI makes at most one; more than this live at once means something's wrong. */
const MAX_TICKETS = 32;
const TICKET = /^[0-9a-f]{32}$/;

export interface SetupGrant {
    /** The connection (window) that created the worktree. */
    owner: object;
    /** The new worktree, by its real path: the terminal's folder. */
    path: string;
    /** The repository's main checkout. */
    main: string;
    /** The scripts list the script is in. */
    project: string;
    script: string;
    command: string;
    expires: number;
}

/**
 * Only the user's say-so counts, for the repository (its main checkout covers the worktrees inside it) or for
 * the new folder. A folder trusted for having nothing to protect says nothing about whether the repository's
 * code is safe to run, and `bun install` or `make` runs it.
 */
export function setupTrusted(main: string, path: string): boolean {
    return trustedByUser(main) || trustedByUser(path);
}

/** `why` is a sentence the window shows in the setup tab, after its own "didn't run". */
const refuse = (why: string) => new RpcError(why, "setup_refused");

export class SetupTickets {
    private live = new Map<string, SetupGrant>();

    /** `now` is replaceable for tests. */
    constructor(public now: () => number = Date.now) {}

    get size() {
        return this.live.size;
    }

    issue(grant: Omit<SetupGrant, "expires">): string {
        const now = this.now();
        for (const [t, g] of this.live) if (g.expires <= now) this.live.delete(t);
        // The oldest goes first (a Map keeps its insertion order).
        while (this.live.size >= MAX_TICKETS) this.live.delete(this.live.keys().next().value!);
        const ticket = randomBytes(16).toString("hex");
        this.live.set(ticket, { ...grant, expires: now + SETUP_TTL_MS });
        return ticket;
    }

    /** The grant for `ticket`, which is gone from here on whatever happens next. */
    take(owner: object, ticket: unknown): SetupGrant {
        if (typeof ticket !== "string" || !TICKET.test(ticket)) throw new RpcError("setup must be a ticket from projects.createWorktree", "invalid");
        const grant = this.live.get(ticket);
        this.live.delete(ticket);
        if (!grant) throw refuse("This setup run was already started, or the window reconnected since the worktree was created.");
        if (grant.owner !== owner) throw refuse("This setup run belongs to another window.");
        if (grant.expires <= this.now()) throw refuse("This setup run wasn't started in time.");
        return grant;
    }

    /** The window went away (closed, reloaded, disconnected): its tickets go with it. */
    drop(owner: object) {
        for (const [t, g] of this.live) if (g.owner === owner) this.live.delete(t);
    }
}

/** Everything again, as the run starts: the worktree, the script as marked, and the user's trust. */
export function checkGrant(grant: SetupGrant, cwd: string, found: { project: string; script: ProjectScript }) {
    if (resolve(cwd) !== grant.path) throw refuse("The setup script runs only in the worktree it was created for.");
    let real: string | undefined;
    try {
        real = statSync(grant.path).isDirectory() ? realpathSync(grant.path) : undefined;
    } catch {}
    if (real !== grant.path) throw refuse("The new worktree's folder is gone.");
    if (found.project !== grant.project || found.script.id !== grant.script) throw refuse("That isn't the project's setup script.");
    if (!found.script.runOnWorktreeCreate) throw refuse("The script is no longer marked to run when a worktree is created.");
    if (found.script.command !== grant.command) throw refuse("The script's command changed after the worktree was created.");
    if (!setupTrusted(grant.main, grant.path)) throw refuse("The repository isn't trusted, so its setup script doesn't run.");
}
