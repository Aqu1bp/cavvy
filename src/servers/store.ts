// The servers this machine knows: ~/.cavvy/servers.json. A server is somewhere
// reached over SSH that runs Cavvy for you (src/servers/host.ts); this file
// holds only how to reach it. No key and no sign-in is kept here: each
// connection signs in again over SSH (src/servers/connect.ts).

import { randomBytes } from "crypto";
import { existsSync, linkSync, readFileSync, rmSync, writeFileSync } from "fs";
import { hostname } from "os";
import { isAbsolute, join, resolve } from "path";
import { cavvyHome, ensureDir } from "../config/paths";
import { writeJson } from "../config/settings";

export interface ServerEntry {
    /** What you call it: `cavvy --server <name>`. */
    name: string;
    /** As ssh takes it: `user@host`, or a Host from ~/.ssh/config. */
    destination: string;
    port?: number;
    /** A private key file, when it isn't one ssh would find by itself: a full path, or one from home (`~/…`). */
    identityFile?: string;
    /** Where this server's host key is kept, when the user's ssh config keeps none for it (ssh.ts trustHostKey). */
    knownHostsFile?: string;
    addedAt: string;
}

interface StoreFile {
    servers?: ServerEntry[];
}

export class ServerError extends Error {}

export const serversFile = () => join(cavvyHome(), "servers.json");
/** This machine's id, as servers know it: its sign-ins and its runs on a server are under it. A file of its own, so making it never rewrites the list. */
export const desktopIdFile = () => join(cavvyHome(), "servers-id");

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** `user@host` or a config Host: nothing ssh could take for an option, and nothing a shell or a URL would read into. */
const DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+[\]-]{0,252}$/;

function read(): StoreFile {
    const file = serversFile();
    if (!existsSync(file)) return {};
    let data: unknown;
    try {
        data = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
        throw new ServerError(`${file} isn't valid JSON. Fix it or delete it.`);
    }
    const d = (data && typeof data === "object" ? data : {}) as StoreFile;
    const servers = (Array.isArray(d.servers) ? d.servers : []).filter((s): s is ServerEntry => {
        try {
            return Boolean(s) && typeof s === "object" && checked(s).name === s.name;
        } catch {
            return false;
        }
    });
    return { servers };
}

function write(data: StoreFile) {
    writeJson(serversFile(), data, 0o600);
}

/** The entry as it's saved, or why it can't be. */
function checked(e: Partial<ServerEntry>): ServerEntry {
    const name = String(e.name ?? "");
    if (!NAME.test(name)) throw new ServerError("A server's name is lowercase letters, digits and dashes, up to 40 (like build-box).");
    const destination = String(e.destination ?? "");
    if (!DESTINATION.test(destination)) throw new ServerError(`${JSON.stringify(destination)} isn't an SSH destination. Use user@host, or a Host from your SSH config.`);
    const out: ServerEntry = { name, destination, addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString() };
    if (e.port !== undefined) {
        if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new ServerError("The port must be a number from 1 to 65535.");
        out.port = e.port;
    }
    if (e.identityFile !== undefined) {
        const f = String(e.identityFile);
        if (!f || /[\0\n\r]/.test(f)) throw new ServerError("That isn't a key file's path.");
        // Not as typed: a path from the folder it was added in would only work from there.
        out.identityFile = f === "~" || f.startsWith("~/") || isAbsolute(f) ? f : resolve(f);
    }
    if (e.knownHostsFile !== undefined) {
        const f = String(e.knownHostsFile);
        if (!isAbsolute(f) || /[\0\n\r]/.test(f)) throw new ServerError("That isn't a known-hosts file's path.");
        out.knownHostsFile = f;
    }
    return out;
}

export function listServers(): ServerEntry[] {
    return read().servers ?? [];
}

export function getServer(name: string): ServerEntry | undefined {
    return listServers().find((s) => s.name === name);
}

export function requireServer(name: string): ServerEntry {
    const s = getServer(name);
    if (s) return s;
    const known = listServers().map((x) => x.name);
    throw new ServerError(known.length ? `No server named ${name}. You have: ${known.join(", ")}.` : `No server named ${name}. Add one with: cavvy servers add <name> <user@host>`);
}

/** What `add` would save, checked, without saving it (the connection is tried first). */
export function draftServer(e: { name: string; destination: string; port?: number; identityFile?: string; knownHostsFile?: string }): ServerEntry {
    const entry = checked(e);
    if (getServer(entry.name)) throw new ServerError(`There's already a server named ${entry.name}.`);
    return entry;
}

/** Saves it. An entry of that name is replaced (putting a removed one back is the same call). */
export function saveServer(e: ServerEntry): ServerEntry {
    const entry = checked(e);
    const data = read();
    data.servers = [...(data.servers ?? []).filter((s) => s.name !== entry.name), entry];
    write(data);
    return entry;
}

/** Takes it off the list and hands it back, so the caller can undo. */
export function removeServer(name: string): ServerEntry {
    const entry = requireServer(name);
    const data = read();
    data.servers = (data.servers ?? []).filter((s) => s.name !== name);
    write(data);
    return entry;
}

export interface Desktop {
    id: string;
    /** What a server shows for this machine. */
    label: string;
}

function savedDesktopId(): string | undefined {
    try {
        const id = readFileSync(desktopIdFile(), "utf-8").trim();
        return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
}

/**
 * This machine's id: made once, by whichever process asks first. Two that ask at the same moment end with the
 * same one: each writes its own beside the file, and only the first gets to give it the file's name.
 */
function desktopId(): string {
    const had = savedDesktopId();
    if (had) return had;
    const file = desktopIdFile();
    ensureDir(cavvyHome());
    const mine = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
    const made = `${randomBytes(16).toString("hex")}\n`;
    writeFileSync(mine, made, { mode: 0o600 });
    try {
        linkSync(mine, file);
    } catch (e) {
        // EEXIST: another process got there first, or the file is there and isn't an id (said below). Anything else:
        // a disk that has no links (FAT, some network shares), where the file is made in one step instead, which
        // still lets only the first one make it.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
            try {
                writeFileSync(file, made, { mode: 0o600, flag: "wx" });
            } catch {
                // there already
            }
        }
    } finally {
        rmSync(mine, { force: true });
    }
    // Made in one step, it can be seen for a moment before it's written.
    let id = savedDesktopId();
    for (let i = 0; !id && i < 5; i++) {
        Bun.sleepSync(20);
        id = savedDesktopId();
    }
    if (!id) throw new ServerError(`${file} doesn't hold this machine's id. Delete it.`);
    return id;
}

/** This machine as servers know it. The id is made once and kept. */
export function thisDesktop(): Desktop {
    const id = desktopId();
    return {
        id,
        label:
            hostname()
                .replace(/\.local$/, "")
                .replace(/[^\w .-]/g, "")
                .slice(0, 60) || "desktop",
    };
}
