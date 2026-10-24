// A stand-in for Chrome, for tests of everything around the browser (starting and stopping it, tabs, who drives them, what a
// page may load) that needn't a real one: it opens a DevTools endpoint the way Chrome does (DevToolsActivePort in the profile,
// /json/version, a WebSocket) and answers the commands the browser code sends with scripted replies. Run through
// test/helpers/fake-chrome.ts.
//
// Besides CDP it has a control endpoint on the same port: GET /fake/log is every command it was sent, POST /fake/event emits an
// event to the client ({ method, params, sessionId }), POST /fake/popup opens a tab as window.open would.
//
// FAKE_CHROME=exit      exits at once, saying something on stderr
// FAKE_CHROME=silent    runs, and never opens its endpoint
// FAKE_CHROME=slow      answers Target.setAutoAttach never (a browser that doesn't finish starting)
import { mkdirSync, writeFileSync } from "fs";
import { SHOP, axTree } from "./ax-tree";

const dir = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!dir) throw new Error("no --user-data-dir");
const mode = process.env.FAKE_CHROME;
if (mode === "exit") {
    console.error("fake chrome: refusing to start");
    process.exit(21);
}
if (mode === "silent") setInterval(() => undefined, 1000);

// 1x1 images
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const DOM_SNAPSHOT = { strings: ["", "A", "href", "/other", "http://127.0.0.1/", "INPUT", "type", "password"], documents: [{ baseURL: 4, nodes: { nodeName: [1, 5], backendNodeId: [4, 25], attributes: [[2, 3], [6, 7]] } }] };

interface Target {
    id: string;
    session: string;
    url: string;
    history: string[];
    index: number;
    /** The page's size in CSS pixels (Emulation.setDeviceMetricsOverride). */
    view: { width: number; height: number };
    casting: boolean;
}
const targets = new Map<string, Target>();
const log: { method: string; params: unknown; sessionId?: string }[] = [];
let seq = 0;
let loaders = 0;
let objects = 0;
const sockets = new Set<{ send(data: string): void }>();
const emit = (method: string, params: unknown, sessionId?: string) => {
    for (const ws of sockets) ws.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
};
const titleOf = (url: string) => (url === "about:blank" ? "" : `Page at ${url}`);

function open(opener?: string): Target {
    const n = ++seq;
    const t: Target = { id: `T${n}`, session: `S${n}`, url: "about:blank", history: ["about:blank"], index: 0, view: { width: 1280, height: 800 }, casting: false };
    targets.set(t.id, t);
    emit("Target.attachedToTarget", { sessionId: t.session, targetInfo: { targetId: t.id, type: "page", url: "about:blank", ...(opener ? { openerId: opener } : {}) }, waitingForDebugger: true });
    return t;
}

function navigate(t: Target, url: string, push = true) {
    if (push) {
        t.history = [...t.history.slice(0, t.index + 1), url];
        t.index = t.history.length - 1;
    }
    t.url = url;
    emit("Page.frameStartedLoading", { frameId: t.id }, t.session);
    emit("Page.frameNavigated", { frame: { id: t.id, url, loaderId: `L${++loaders}` } }, t.session);
    emit("Page.frameStoppedLoading", { frameId: t.id }, t.session);
}

const box = [10, 10, 110, 10, 110, 40, 10, 40];

/** A frame of the page, as Chrome sends one when it has changed: the page's size in CSS pixels. */
function frame(t: Target) {
    if (t.casting) emit("Page.screencastFrame", { data: JPEG, sessionId: ++seq, metadata: { deviceWidth: t.view.width, deviceHeight: t.view.height } }, t.session);
}

function answer(method: string, params: any, sessionId?: string): unknown {
    const t = [...targets.values()].find((x) => x.session === sessionId);
    switch (method) {
        case "Target.createTarget": {
            const made = open();
            // Chrome reports the attached page around the same time as the answer.
            return { targetId: made.id };
        }
        case "Target.closeTarget":
            targets.delete(params.targetId);
            setTimeout(() => emit("Target.targetDestroyed", { targetId: params.targetId }), 0);
            return { success: true };
        case "Page.navigate":
            setTimeout(() => navigate(t!, params.url), 0);
            return { frameId: t?.id };
        case "Page.getNavigationHistory":
            return { currentIndex: t!.index, entries: t!.history.map((url, id) => ({ id, url })) };
        case "Page.navigateToHistoryEntry":
            t!.index = params.entryId;
            setTimeout(() => navigate(t!, t!.history[t!.index]!, false), 0);
            return {};
        case "Page.reload":
            setTimeout(() => navigate(t!, t!.url, false), 0);
            return {};
        case "Page.getLayoutMetrics":
            return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 }, cssContentSize: { width: 1280, height: 2000 } };
        case "Page.captureScreenshot":
            return { data: params.format === "jpeg" ? JPEG : PNG };
        case "Emulation.setDeviceMetricsOverride":
            t!.view = { width: params.width, height: params.height };
            return {};
        case "Page.startScreencast":
            t!.casting = true;
            setTimeout(() => frame(t!), 0);
            return {};
        case "Page.stopScreencast":
            t!.casting = false;
            return {};
        case "Page.handleJavaScriptDialog":
            setTimeout(() => emit("Page.javascriptDialogClosed", { result: params.accept }, sessionId), 0);
            return {};
        case "Runtime.evaluate":
            if (params.expression === "document.title") return { result: { type: "string", value: titleOf(t?.url ?? "") } };
            if (params.expression === "document.activeElement") return { result: { type: "object", objectId: `O${++objects}` } };
            // a script may change what the page shows
            setTimeout(() => frame(t!), 0);
            return { result: { type: "number", value: 42 } };
        case "Runtime.callFunctionOn":
            return { result: { value: true } };
        case "Accessibility.getFullAXTree":
            return { nodes: axTree(SHOP) };
        case "DOMSnapshot.captureSnapshot":
            return DOM_SNAPSHOT;
        case "DOM.getBoxModel":
            return { model: { content: box, border: box } };
        case "DOM.resolveNode":
            return { object: { objectId: `O${++objects}` } };
        default:
            return {};
    }
}

const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/fake` });
        if (url.pathname === "/fake/log") return Response.json(log);
        if (url.pathname === "/fake/event") {
            const e = (await req.json()) as { method: string; params: unknown; sessionId?: string };
            emit(e.method, e.params, e.sessionId);
            return Response.json({});
        }
        if (url.pathname === "/fake/popup") {
            const { opener } = (await req.json()) as { opener: string };
            return Response.json({ targetId: open(opener).id });
        }
        if (url.pathname === "/devtools/browser/fake" && srv.upgrade(req)) return undefined;
        return new Response("not found", { status: 404 });
    },
    websocket: {
        open: (ws) => void sockets.add(ws),
        close: (ws) => void sockets.delete(ws),
        message(ws, raw) {
            const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown; sessionId?: string };
            log.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
            if (msg.method === "Fake.hang" || (mode === "slow" && msg.method === "Target.setAutoAttach")) return;
            const result = answer(msg.method, msg.params ?? {}, msg.sessionId);
            ws.send(JSON.stringify({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
        },
    },
});

if (mode !== "silent") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/DevToolsActivePort`, `${server.port}\n/devtools/browser/fake`);
}
