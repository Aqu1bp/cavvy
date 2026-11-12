// The servers this machine knows: ~/.cavvy/servers.json. A server is somewhere
// reached over SSH that runs Cavvy for you (src/servers/host.ts); this file
// holds only how to reach it. No key and no sign-in is kept here: each
// connection signs in again over SSH (src/servers/connect.ts).

import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { hostname } from "os";
import { join } from "path";
import { cavvyHome } from "../config/paths";
import { writeJson } from "../config/settings";

export interface ServerEntry {
    /** What you call it: `cavvy --server <name>`. */
    name: string;
    /** As ssh takes it: `user@host`, or a Host from ~/.ssh/config. */
    destination: string;
    port?: number;
    /** A private key file, when it isn't one ssh would find by itself. */
    identityFile?: string;
    addedAt: string;
}

interface StoreFile {
    /** This machine, as servers know it: its sign-ins on a server are under this id. */
    desktop?: string;
    servers?: ServerEntry[];
}

export class ServerError extends Error {}

export const serversFile = () => join(cavvyHome(), "servers.json");

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
    return { desktop: typeof d.desktop === "string" && /^[0-9a-f]{32}$/.test(d.desktop) ? d.desktop : undefined, servers };
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
        out.identityFile = f;
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
export function draftServer(e: { name: string; destination: string; port?: number; identityFile?: string }): ServerEntry {
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

/** This machine as servers know it. The id is made once and kept. */
export function thisDesktop(): Desktop {
    const data = read();
    let id = data.desktop;
    if (!id) {
        id = randomBytes(16).toString("hex");
        write({ ...data, desktop: id });
    }
    return {
        id,
        label:
            hostname()
                .replace(/\.local$/, "")
                .replace(/[^\w .-]/g, "")
                .slice(0, 60) || "desktop",
    };
}
