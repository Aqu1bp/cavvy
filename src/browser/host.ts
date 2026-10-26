// The desktop app's own browser. In the Electron app the Browser pane is a real Chromium view in the window, and the
// agent drives those same tabs: the app connects to the server (/browser-host, with the server's token) and speaks the
// DevTools protocol for them. The pool of each project opens a channel on that connection where it would otherwise
// start a headless Chrome, and drives it with the same CdpClient; the app answers the few browser-wide commands the
// pool uses (making, closing and fronting tabs) itself, and passes each tab's commands to that tab's debugger.
//
// Wire: every message is JSON with the channel it's on. Server → app: { channel, open: { profile } } to open one,
// { channel, data } with a DevTools message, { channel, close: true }. App → server: { channel, data } with a
// DevTools answer or event, { channel, closed: true } when the app has dropped it (its window closed, say).

import type { ChromeProcess } from "./chrome";

export interface HostSocket {
    send(text: string): void;
    close(code?: number, reason?: string): void;
}

/** What CdpClient needs of a connection: a WebSocket, or a channel to the desktop app. */
export interface CdpTransport {
    send(text: string): void;
    close(): void;
    onmessage: ((event: { data: string }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
}

class Channel implements CdpTransport {
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ended = false;
    private endFns: (() => void)[] = [];

    constructor(
        readonly id: string,
        private host: DesktopHost,
    ) {}

    send(text: string) {
        if (this.ended) throw new Error("The desktop app's browser is closed");
        this.host.write({ channel: this.id, data: text });
    }

    close() {
        if (this.ended) return;
        this.host.write({ channel: this.id, close: true });
        this.end();
    }

    onEnd(fn: () => void) {
        if (this.ended) fn();
        else this.endFns.push(fn);
    }

    end() {
        if (this.ended) return;
        this.ended = true;
        this.host.channels.delete(this.id);
        this.onclose?.();
        for (const fn of this.endFns.splice(0)) fn();
    }
}

export class DesktopHost {
    readonly channels = new Map<string, Channel>();

    constructor(private socket: HostSocket) {}

    write(msg: unknown) {
        this.socket.send(JSON.stringify(msg));
    }

    /** A browser for one project: `profile` names its cookies and storage, kept between runs. */
    open(profile: string): ChromeProcess {
        const channel = new Channel(crypto.randomUUID(), this);
        this.channels.set(channel.id, channel);
        this.write({ channel: channel.id, open: { profile } });
        const exited = new Promise<void>((resolve) => channel.onEnd(resolve));
        return {
            // Not a process of ours: nothing signals it. It ends with its channel.
            pid: 0,
            cdp: CdpClient.over(channel),
            profile,
            exitCode: null,
            exited,
            stop: async () => channel.close(),
        };
    }

    receive(raw: string) {
        let msg: { channel?: unknown; data?: unknown; closed?: unknown };
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        const channel = typeof msg.channel === "string" ? this.channels.get(msg.channel) : undefined;
        if (!channel) return;
        if (msg.closed === true) channel.end();
        else if (typeof msg.data === "string") channel.onmessage?.({ data: msg.data });
    }

    /** The app went away: every browser on it is gone. */
    gone() {
        for (const channel of [...this.channels.values()]) channel.end();
    }
}

let current: DesktopHost | undefined;

/** The desktop app's browser, while the app is connected. */
export function desktopHost(): DesktopHost | undefined {
    return current;
}

/** The app connected: it hosts the browsers from now on (a newer connection replaces an older one). */
export function attachDesktopHost(socket: HostSocket): DesktopHost {
    const previous = current;
    current = new DesktopHost(socket);
    previous?.gone();
    return current;
}

export function detachDesktopHost(host: DesktopHost) {
    host.gone();
    if (current === host) current = undefined;
}
