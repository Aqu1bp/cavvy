// Drive only the Chrome started with this test's private profile. Port 0 lets
// Chrome choose a port; its profile supplies the browser's unique endpoint.
//
// The work has two parts with different limits, because a slow runner stretches them differently:
// - startup: from the call (right after spawning Chrome) until the DevTools connection is open.
//   This is Chrome starting, which is not our code, so a loaded 2-core runner is given a lot of time.
// - fixture: from the open connection until the page reports its result. This is our page, so
//   only a stuck page should exceed its limit.
// Each limit starts when its part starts, so a slow start never eats into the fixture's time.
// `timings` receives the milliseconds since the call at which each step finished.
export type ChromeLimits = { startupMs: number; fixtureMs: number };
export type ChromeTimings = Record<string, number>;

export async function chromeFixture(browser: { exitCode: number | null }, profile: string, url: string, limits: ChromeLimits, timings: ChromeTimings = {}): Promise<{ status: string; message: string }> {
    const started = performance.now();
    const mark = (name: string) => { timings[name] = Math.round(performance.now() - started); };
    const stop = new AbortController();
    const signal = stop.signal;
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    const startLimit = (phase: string, ms: number) => {
        clearTimeout(limitTimer);
        limitTimer = setTimeout(() => stop.abort(new Error(`Chrome ${phase} timed out after ${ms} ms; steps finished at ${JSON.stringify(timings)} ms`)), ms);
    };
    startLimit("startup", limits.startupMs);

    let socket: WebSocket | undefined;
    try {
        let endpoint: RegExpMatchArray | null = null;
        while (!endpoint) {
            signal.throwIfAborted();
            if (browser.exitCode !== null) throw new Error(`Chrome exited before connecting (${browser.exitCode})`);
            const portFile = await Bun.file(`${profile}/DevToolsActivePort`).text().catch(() => "");
            endpoint = portFile.match(/^(\d+)\n(\/devtools\/browser\/[^\s]+)/);
            if (!endpoint) await Bun.sleep(25);
        }
        mark("devToolsActivePort");
        const address = `127.0.0.1:${endpoint[1]}`;
        const expected = `ws://${address}${endpoint[2]}`;
        const version = await fetch(`http://${address}/json/version`, { signal }).then((r) => r.json()) as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl !== expected || browser.exitCode !== null) throw new Error("DevTools endpoint is not this test's Chrome");
        mark("jsonVersion");

        const ws = socket = new WebSocket(expected);
        let seq = 0;
        const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
        let rejectConnection: (error: Error) => void = () => {};
        const connected = new Promise<void>((resolve, reject) => {
            rejectConnection = reject;
            ws.onopen = () => resolve();
        });
        const fail = (error: Error) => {
            rejectConnection(error);
            for (const request of pending.values()) request.reject(error);
            pending.clear();
        };
        ws.onerror = () => fail(new Error("Chrome DevTools connection failed"));
        ws.onclose = () => fail(new Error("Chrome DevTools connection closed"));
        ws.onmessage = (event) => {
            const message = JSON.parse(String(event.data));
            const id = message.method === "Page.loadEventFired" ? -1 : message.id;
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            if (message.error) request.reject(new Error(message.error.message));
            else request.resolve(message.result);
        };
        const abort = () => { fail(signal.reason); ws.close(); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const request = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
            signal.throwIfAborted();
            const id = ++seq;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
        });
        try {
            await connected;
            mark("connected");
            startLimit("fixture", limits.fixtureMs);
            // Navigate only a target we created in our verified browser.
            const { targetId } = await request("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await request("Target.attachToTarget", { targetId, flatten: true });
            await request("Page.enable", {}, sessionId);
            mark("targetReady");
            const loaded = new Promise<void>((resolve, reject) => { pending.set(-1, { resolve, reject }); });
            await Promise.all([loaded, request("Page.navigate", { url }, sessionId)]);
            mark("pageLoaded");
            const response = await request("Runtime.evaluate", {
                expression: `new Promise(resolve => {
                        const timer = setInterval(() => {
                            const result = document.getElementById('result');
                            if (result?.dataset.status) {
                                clearInterval(timer);
                                resolve({ status: result.dataset.status, message: result.textContent });
                            }
                        }, 50);
                    })`,
                awaitPromise: true, returnByValue: true,
            }, sessionId);
            if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
            mark("result");
            return response.result.value;
        } finally {
            signal.removeEventListener("abort", abort);
        }
    } finally {
        clearTimeout(limitTimer);
        socket?.close();
    }
}
