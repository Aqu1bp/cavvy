// Drive only the Chrome started with this test's private profile. Port 0 lets
// Chrome choose a port; its profile supplies the browser's unique endpoint.
export async function chromeFixture(browser: { exitCode: number | null }, profile: string, url: string, signal: AbortSignal): Promise<{ status: string; message: string }> {
    let endpoint: RegExpMatchArray | null = null;
    while (!endpoint) {
        signal.throwIfAborted();
        if (browser.exitCode !== null) throw new Error(`Chrome exited before connecting (${browser.exitCode})`);
        const portFile = await Bun.file(`${profile}/DevToolsActivePort`).text().catch(() => "");
        endpoint = portFile.match(/^(\d+)\n(\/devtools\/browser\/[^\s]+)/);
        if (!endpoint) await Bun.sleep(25);
    }
    const address = `127.0.0.1:${endpoint[1]}`;
    const expected = `ws://${address}${endpoint[2]}`;
    const version = await fetch(`http://${address}/json/version`, { signal }).then((r) => r.json()) as { webSocketDebuggerUrl?: string };
    if (version.webSocketDebuggerUrl !== expected || browser.exitCode !== null) throw new Error("DevTools endpoint is not this test's Chrome");

    const socket = new WebSocket(expected);
    let seq = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let rejectConnection: (error: Error) => void = () => {};
    const connected = new Promise<void>((resolve, reject) => {
        rejectConnection = reject;
        socket.onopen = () => resolve();
    });
    const fail = (error: Error) => {
        rejectConnection(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
    };
    socket.onerror = () => fail(new Error("Chrome DevTools connection failed"));
    socket.onclose = () => fail(new Error("Chrome DevTools connection closed"));
    socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        const id = message.method === "Page.loadEventFired" ? -1 : message.id;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    };
    const abort = () => { fail(new Error("Chrome fixture timed out")); socket.close(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const request = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
    try {
        await connected;
        // Navigate only a target we created in our verified browser.
        const { targetId } = await request("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await request("Target.attachToTarget", { targetId, flatten: true });
        await request("Page.enable", {}, sessionId);
        const loaded = new Promise<void>((resolve, reject) => { pending.set(-1, { resolve, reject }); });
        await Promise.all([loaded, request("Page.navigate", { url }, sessionId)]);
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
        return response.result.value;
    } finally {
        signal.removeEventListener("abort", abort);
        socket.close();
    }
}
