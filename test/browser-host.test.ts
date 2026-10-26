// The desktop app's browser, from the server's side (src/browser/host.ts): each project's browser is a channel on
// the app's connection, driven with the same CdpClient as a Chrome the server starts.
import { afterEach, expect, test } from "bun:test";
import { attachDesktopHost, desktopHost, detachDesktopHost, type DesktopHost } from "../src/browser/host";

function app() {
    const sent: any[] = [];
    const host = attachDesktopHost({ send: (text) => void sent.push(JSON.parse(text)), close() {} });
    return { host, sent };
}

let attached: DesktopHost | undefined;
afterEach(() => {
    if (attached) detachDesktopHost(attached);
    attached = undefined;
});

test("a project's browser is a channel: opened with its profile, commands out and answers back on it", async () => {
    const { host, sent } = app();
    attached = host;
    const browser = host.open("/home/p/browser");
    expect(browser.profile).toBe("/home/p/browser");
    expect(sent[0]).toEqual({ channel: expect.any(String), open: { profile: "/home/p/browser" } });
    const channel = sent[0].channel;
    const version = browser.cdp.send<{ product: string }>("Browser.getVersion");
    const out = JSON.parse(sent[1].data);
    expect(sent[1].channel).toBe(channel);
    expect(out).toMatchObject({ method: "Browser.getVersion" });
    host.receive(JSON.stringify({ channel, data: JSON.stringify({ id: out.id, result: { product: "Chrome/140" } }) }));
    expect(await version).toEqual({ product: "Chrome/140" });
});

test("events reach the page's listeners; messages for another channel, or not JSON, are dropped", async () => {
    const { host, sent } = app();
    attached = host;
    const browser = host.open("p");
    const channel = sent[0].channel;
    const seen: unknown[] = [];
    browser.cdp.on("Target.targetInfoChanged", (p) => void seen.push(p));
    host.receive("not json");
    host.receive(JSON.stringify({ channel: "someone-else", data: JSON.stringify({ method: "Target.targetInfoChanged", params: { x: 1 } }) }));
    host.receive(JSON.stringify({ channel, data: JSON.stringify({ method: "Target.targetInfoChanged", params: { x: 2 } }) }));
    expect(seen).toEqual([{ x: 2 }]);
});

test("the app dropping a channel ends that browser, as a Chrome exiting would", async () => {
    const { host, sent } = app();
    attached = host;
    const browser = host.open("p");
    const pending = browser.cdp.send("Page.navigate", { url: "https://example.com" });
    host.receive(JSON.stringify({ channel: sent[0].channel, closed: true }));
    await browser.exited;
    expect(browser.cdp.closed).toBe(true);
    await expect(pending).rejects.toThrow();
    expect(host.channels.size).toBe(0);
});

test("stopping a browser tells the app to close its channel", async () => {
    const { host, sent } = app();
    attached = host;
    const browser = host.open("p");
    await browser.stop();
    await browser.exited;
    expect(sent.at(-1)).toEqual({ channel: sent[0].channel, close: true });
});

test("a newer connection from the app takes over: browsers on the old one end", async () => {
    const first = app();
    const browser = first.host.open("p");
    const second = app();
    attached = second.host;
    await browser.exited;
    expect(desktopHost()).toBe(second.host);
    detachDesktopHost(first.host);
    expect(desktopHost()).toBe(second.host);
    detachDesktopHost(second.host);
    attached = undefined;
    expect(desktopHost()).toBeUndefined();
});
