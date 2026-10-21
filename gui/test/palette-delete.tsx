// Actual palette and app event handling, with a controlled RPC boundary.
import { render } from "solid-js/web";
import type { ServerEvent, SessionSearchHit, SessionSearchResult, SessionSummary } from "@shared/protocol";
import { CommandPalette } from "../src/components/CommandPalette";
import { RpcError, type ConnectionState } from "../src/lib/rpc";
import { app, refreshSessions, rpc, setApp, start, toasts, wasDeleted } from "../src/state/app";
import { jumpTarget, setJumpTarget, setPaletteOpen } from "../src/state/ui";
import "../src/styles/overlays.css";

function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
async function until(ok: () => boolean) {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    check(ok(), "palette fixture timed out");
}

export async function checkPaletteDelete(root: HTMLElement) {
    const previousId = app.activeId;
    const original = { call: rpc.call, connect: rpc.connect, onEvent: rpc.onEvent, onState: rpc.onState };
    let event!: (ev: ServerEvent) => void;
    let connection!: (s: ConnectionState, attempt: number) => void;
    const pending: ((r: SessionSearchResult) => void)[] = [];
    let defer = false;
    let deferLists = false;
    let listed: SessionSummary[] = [];
    const pendingLists: (() => void)[] = [];
    const calls: string[] = [];
    const hits: SessionSearchHit[] = ["removed", "late", "missing"].map((id) => ({
        id: `palette-${id}`, title: `Fixture ${id}`, cwd: "/fixture", projectName: "fixture", archived: false,
        seg: 0, index: 1, role: "assistant", snippet: "palettequokka reply", match: [0, 13], at: Date.now(),
    }));
    const available = new Set(hits.map((h) => h.id));
    const answer = (): SessionSearchResult => ({ hits: hits.filter((h) => available.has(h.id)), partial: false });
    const send = (ev: ServerEvent) => {
        if (ev.type === "sessions.remove") available.delete(ev.id);
        if (ev.type === "sessions.upsert") available.add(ev.session.id);
        event(ev);
    };
    const summary = (hit: SessionSearchHit, archived = false): SessionSummary => ({
        id: hit.id, cwd: hit.cwd, title: hit.title, projectName: hit.projectName, archived,
        createdAt: hit.at, updatedAt: hit.at, messages: 2, status: "idle", pinned: false, settled: false, live: false,
    });
    const nextSearch = async () => {
        await until(() => pending.length > 0);
        return pending.shift()!;
    };
    // Drive real event/reconnect handlers without opening a network connection.
    rpc.onEvent = (fn) => { event = fn; return () => {}; };
    rpc.onState = (fn) => { connection = fn; return () => {}; };
    rpc.connect = async () => {};
    rpc.call = (async (method: string, params: any) => {
        if (method === "sessions.search") {
            if (defer) return new Promise<SessionSearchResult>((resolve) => { pending.push(resolve); });
            return answer();
        }
        if (method === "sessions.list") {
            const rows = listed.filter((s) => s.archived === !!params.archived).slice(0, params.limit);
            if (deferLists) return new Promise((resolve) => { pendingLists.push(() => resolve(rows)); });
            return rows;
        }
        if (method === "hello" || method === "settings.get") return {};
        if (["projects.recent", "providers.list", "models.list"].includes(method)) return [];
        if (method === "session.open") {
            // The selected session is restored after bootstrap (#74); keep it selected, unopened.
            if (params.id === "palette-current") return new Promise(() => {});
            calls.push(params.id);
            throw new RpcError(`No session ${params.id}`, "not_found");
        }
        throw new Error(`Unexpected palette RPC: ${method}`);
    }) as typeof rpc.call;
    start();
    setApp("activeId", "palette-current");
    setPaletteOpen(true);
    const dispose = render(() => <CommandPalette />, root);
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".palette .pal-row")];
    const messageRows = () => rows().filter((r) => r.querySelector(".pal-snippet"));
    const type = (q: string) => {
        const input = document.querySelector<HTMLInputElement>(".palette input")!;
        input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input;
    };
    try {
        connection("open", 0);
        await until(() => app.modelsLoaded);
        await until(() => rows().some((r) => r.textContent?.includes("Delete session…")));
        check(rows().some((r) => r.textContent?.includes("Review changes")), "review and delete actions coexist");
        type("palettequokka");
        await until(() => messageRows().length === 3);
        check(document.querySelector(".palette .pal-h")?.textContent === "Messages", "message hits retain their section");
        setJumpTarget({ sessionId: hits[0]!.id, seg: 0, index: 1, role: "assistant", query: "palettequokka" });
        send({ type: "sessions.remove", id: hits[0]!.id });
        await until(() => messageRows().length === 2);
        check(!jumpTarget() && !rows().some((r) => r.textContent?.includes("Fixture removed")), "deletion drops the displayed hit and pending jump");

        defer = true;
        type("palettequokka reply");
        const beforeDelete = await nextSearch();
        send({ type: "sessions.remove", id: hits[1]!.id });
        send({ type: "sessions.upsert", session: summary(hits[1]!) });
        check(!wasDeleted(hits[1]!.id), "Undo upsert clears its deletion marker");
        beforeDelete({ hits, partial: false });
        const afterUndo = await nextSearch();
        check(messageRows().length === 0, "Undo cannot revive displayed hits or pending replies from before deletion");
        afterUndo(answer());
        await until(() => messageRows().length === 2);
        check(messageRows().some((r) => r.textContent?.includes("Fixture late")), "fresh search finds the restored session without changing the query");

        defer = false;
        send({ type: "sessions.remove", id: hits[1]!.id });
        await until(() => messageRows().length === 1);
        connection("reconnecting", 1);
        // Undo happened elsewhere while disconnected: no upsert reaches this window.
        available.add(hits[0]!.id);
        available.add(hits[1]!.id);
        const recent = Array.from({ length: 300 }, (_, i) => ({ ...summary(hits[0]!), id: `recent-${i}`, updatedAt: hits[0]!.at + 300 - i }));
        listed = [...recent, summary(hits[0]!), summary(hits[1]!, true)];
        connection("open", 0);
        await until(() => app.sessions.length === 300 && !wasDeleted(hits[1]!.id));
        check(wasDeleted(hits[0]!.id) && !app.sessions.some((s) => s.id === hits[0]!.id), "the restored 301st session remains outside the capped reconnect list");
        check(app.archived.some((s) => s.id === hits[1]!.id), "reconnect sees the restored archived session");
        type("palettequokka");
        await until(() => messageRows().length === 3);
        check(messageRows().some((r) => r.textContent?.includes("Fixture removed")), "a fresh search finds the restored 301st session despite its old marker");

        // A list fetched before a deletion must not clear the newer marker.
        listed = [summary(hits[0]!), summary(hits[1]!, true)];
        deferLists = true;
        const refresh = refreshSessions();
        await until(() => pendingLists.length === 2);
        send({ type: "sessions.remove", id: hits[0]!.id });
        for (const finish of pendingLists.splice(0)) finish();
        await refresh;
        check(wasDeleted(hits[0]!.id) && !app.sessions.some((s) => s.id === hits[0]!.id), "stale list does not undo a deletion received during refresh");
        send({ type: "sessions.remove", id: hits[1]!.id });
        await until(() => messageRows().length === 1);

        const input = document.querySelector<HTMLInputElement>(".palette input")!;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await until(() => wasDeleted(hits[2]!.id));
        check(calls.length === 1 && calls[0] === hits[2]!.id, "Enter attempts the remaining stale hit");
        check(app.activeId === "palette-current" && !jumpTarget(), "missing hit preserves the current session and clears its jump");
        check(toasts.some((t) => t.level === "error" && t.message.includes(hits[2]!.id)), "missing hit reports its failure");
    } finally {
        dispose();
        Object.assign(rpc, original);
        setPaletteOpen(false);
        setJumpTarget(undefined);
        setApp("activeId", previousId);
    }
}
