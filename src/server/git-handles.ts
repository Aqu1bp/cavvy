// What Git changes show can name a registered value: a file, a rename's source, a branch. It's shown redacted.
// Where the GUI acts on one (loads, opens or commits a file, compares with a branch, checks HEAD), it hands back a
// handle instead of the name: random, so it holds nothing of the name, and resolved only by the session that listed
// it, for the folder it was listed in. Names redact() leaves alone need none and go back as they are.

import { randomBytes } from "crypto";
import { realpathSync } from "fs";
import { resolve } from "path";
import type { GitChangesInfo } from "./protocol";
import { RpcError } from "./rpc-error";
import { redact } from "../util/redact";

type Kind = "path" | "ref";

/** A worktree's folder as the diff reader resolves names in it (session-worktrees.ts takes its real path). */
function realFolder(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}
/** Handles kept per session, the oldest let go first: a listing names at most a few thousand. */
const MAX = 4096;

export class GitHandles {
    private byToken = new Map<string, { kind: Kind; root: string; raw: string }>();
    private byName = new Map<string, string>();

    /** `raw` as shown, with a handle when that hides something: the same one each time it's listed. */
    private show(kind: Kind, root: string, raw: string): { text: string; token?: string } {
        const text = redact(raw);
        if (text === raw) return { text };
        const name = JSON.stringify([kind, root, raw]);
        let token = this.byName.get(name);
        const held = token === undefined ? undefined : this.byToken.get(token);
        if (token !== undefined && held) {
            this.byToken.delete(token);
            this.byToken.set(token, held);
        } else {
            token = "git:" + randomBytes(16).toString("base64url");
            this.byToken.set(token, { kind, root, raw });
            this.byName.set(name, token);
            for (const [oldest, h] of this.byToken) {
                if (this.byToken.size <= MAX) break;
                this.byToken.delete(oldest);
                this.byName.delete(JSON.stringify([h.kind, h.root, h.raw]));
            }
        }
        return { text, token };
    }

    private held(kind: Kind, token: unknown) {
        const h = typeof token === "string" ? this.byToken.get(token) : undefined;
        if (h?.kind === kind) return h;
        throw new RpcError(kind === "path" ? "That file is no longer listed here. Refresh the Review pane." : "That branch is no longer listed here. Refresh the Review pane.", "invalid");
    }

    /** The name a handle stands for: one this session listed, of this kind, in this folder. */
    resolve(kind: Kind, root: string, token: unknown): string {
        const h = this.held(kind, token);
        if (h.root !== root) this.held(kind, undefined);
        return h.raw;
    }

    /** Where a listed file is, and the folder it was listed in, to open or reveal it. */
    where(token: unknown): { root: string; path: string } {
        const h = this.held("path", token);
        return { root: h.root, path: resolve(h.root, h.raw) };
    }

    /** Git changes as shown: every name redacted, with a handle where that hid something. */
    shown(info: GitChangesInfo, root: string): GitChangesInfo {
        const ref = (raw: string) => this.show("ref", root, raw);
        const out: GitChangesInfo = {
            ...info,
            files: info.files.map((f) => {
                const p = this.show("path", root, f.path);
                return {
                    ...f,
                    path: p.text,
                    ...(p.token ? { pathToken: p.token } : {}),
                    ...(f.from !== undefined ? { from: redact(f.from) } : {}),
                    ...(f.note !== undefined ? { note: redact(f.note) } : {}),
                    ...(f.filter !== undefined ? { filter: redact(f.filter) } : {}),
                };
            }),
            bases: [],
        };
        // A turn's other worktrees: their branches redacted, and their files with handles for the folder each is in,
        // as the diff reader lists that worktree (by its real path) when the card opens it there.
        if (info.places) {
            out.places = info.places.map((p) => {
                const root = realFolder(p.path);
                return {
                    ...p,
                    ...(p.branch !== undefined ? { branch: redact(p.branch) } : {}),
                    ...(p.base !== undefined ? { base: redact(p.base) } : {}),
                    ...(p.top ? { top: p.top.map((f) => { const n = this.show("path", root, f.path); return { ...f, path: n.text, ...(n.token ? { pathToken: n.token } : {}) }; }) } : {}),
                };
            });
        }
        if (info.reason !== undefined) out.reason = redact(info.reason);
        if (info.notes) out.notes = info.notes.map(redact);
        if (info.turns) out.turns = info.turns.map((t) => ({ ...t, prompt: redact(t.prompt) }));
        if (info.head?.branch !== undefined) {
            const b = ref(info.head.branch);
            out.head = { ...info.head, branch: b.text, ...(b.token ? { branchToken: b.token } : {}) };
        }
        if (info.base) {
            const b = ref(info.base.ref);
            out.base = { ...info.base, ref: b.text, ...(b.token ? { refToken: b.token } : {}) };
        }
        const bases = info.bases.map(ref);
        out.bases = bases.map((b) => b.text);
        if (bases.some((b) => b.token)) out.baseTokens = bases.map((b) => b.token ?? null);
        if (info.defaultBase !== undefined) {
            const d = ref(info.defaultBase);
            out.defaultBase = d.text;
            if (d.token) out.defaultBaseToken = d.token;
        }
        return out;
    }
}

/** An error about Git work, as shown: messages can name files and branches. */
export function redactedError(e: unknown): unknown {
    if (!(e instanceof Error)) return e;
    const message = redact(e.message);
    if (message === e.message) return e;
    return e instanceof RpcError ? new RpcError(message, e.code, e.folder) : new Error(message);
}
