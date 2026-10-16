// Actual palette and app event handling, with a controlled RPC boundary.
import { render } from "solid-js/web";
import type { ServerEvent, SessionSearchHit, SessionSearchResult } from "@shared/protocol";
import { CommandPalette } from "../src/components/CommandPalette";
import { RpcError } from "../src/lib/rpc";
import { app, rpc, setApp, start, toasts, wasDeleted } from "../src/state/app";
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
    let pending: ((r: SessionSearchResult) => void) | undefined;
    let defer = false;
    const calls: string[] = [];
    const hits: SessionSearchHit[] = ["removed", "late", "missing"].map((id) => ({
        id: `palette-${id}`, title: `Fixture ${id}`, cwd: "/fixture", projectName: "fixture", archived: false,
        seg: 0, index: 1, role: "assistant", snippet: "palettequokka reply", match: [0, 13], at: Date.now(),
    }));
    // Register the real app handler, without connecting or changing connection state.
    rpc.onEvent = (fn) => { event = fn; return () => {}; };
    rpc.onState = () => () => {};
    rpc.connect = async () => {};
    rpc.call = (async (method: string, params: any) => {
        if (method === "sessions.search") {
            if (defer) return new Promise<SessionSearchResult>((resolve) => { pending = resolve; });
            return { hits, partial: false };
        }
        if (method === "session.open") {
            calls.push(params.id);
            throw new RpcError(`No session ${params.id}`, "not_found");
        }
        throw new Error(`Unexpected palette RPC: ${method}`);
    }) as typeof rpc.call;
    start();
    setApp("activeId", "palette-current");
    setPaletteOpen(true);
    const dispose = render(() => <CommandPalette />, root);
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".palette .pal-item")];
    const messageRows = () => rows().filter((r) => r.querySelector(".pal-snippet"));
    const type = (q: string) => {
        const input = document.querySelector<HTMLInputElement>(".palette input")!;
        input.value = q;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input;
    };
    try {
        await until(() => rows().some((r) => r.textContent?.includes("Delete session…")));
        check(rows().some((r) => r.textContent?.includes("Review changes")), "review and delete actions coexist");
        type("palettequokka");
        await until(() => messageRows().length === 3);
        check(document.querySelector(".palette .pal-section")?.textContent === "Messages", "message hits retain their section");
        setJumpTarget({ sessionId: hits[0]!.id, seg: 0, index: 1, role: "assistant", query: "palettequokka" });
        event({ type: "sessions.remove", id: hits[0]!.id });
        await until(() => messageRows().length === 2);
        check(!jumpTarget() && !rows().some((r) => r.textContent?.includes("Fixture removed")), "deletion drops the displayed hit and pending jump");

        defer = true;
        const input = type("palettequokka reply");
        await until(() => !!pending);
        event({ type: "sessions.remove", id: hits[1]!.id });
        pending!({ hits, partial: false });
        await until(() => messageRows().length === 1);
        check(messageRows()[0]!.textContent?.includes("Fixture missing"), "late search response cannot reintroduce deleted hits");

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
