// What simctl says (src/simulator/simctl.ts): the devices that can run, in the order the pane and the agent list them,
// and its errors without their boilerplate.
import { expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { parseDevices, pasteboard, runtimeName, setRunner, simctlError } from "../src/simulator/simctl";

afterEach(() => setRunner(undefined));

test("runtimes are named as iOS versions; other platforms aren't offered", () => {
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-27-0")).toBe("iOS 27.0");
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.iOS-26-5")).toBe("iOS 26.5");
    expect(runtimeName("com.apple.CoreSimulator.SimRuntime.watchOS-12-0")).toBeUndefined();
});

test("booted devices come first, then the newest iOS, iPhones before iPads; unavailable ones are left out", () => {
    const json = JSON.stringify({
        devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "A", name: "iPhone 16", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" }],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
                { udid: "B", name: "iPad Air", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air" },
                { udid: "C", name: "iPhone 17", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" },
                { udid: "D", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: false },
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-12-0": [{ udid: "E", name: "Apple Watch", state: "Booted", isAvailable: true }],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{ udid: "F", name: "iPhone Air", state: "Booted", isAvailable: true }],
        },
    });
    const list = parseDevices(json);
    expect(list.map((d) => d.udid)).toEqual(["F", "C", "B", "A"]);
    expect(list[0]).toEqual({ udid: "F", name: "iPhone Air", runtime: "iOS 26.0", state: "booted", kind: "iphone" });
    expect(list[2]!.kind).toBe("ipad");
});

test("an error is the line that says what went wrong", () => {
    expect(simctlError("An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to shutdown device in current state: Shutdown\n")).toBe("Unable to shutdown device in current state: Shutdown");
    expect(simctlError("error: Invalid device: nope\n")).toBe("Invalid device: nope");
});

test("text goes on the pasteboard in a UTF-8 locale, whatever the app's own (pbcopy reads by the locale)", async () => {
    const calls: { args: string[]; input?: string; env?: Record<string, string> }[] = [];
    setRunner(async (args, o) => {
        calls.push({ args, input: o?.input, env: o?.env });
        return { code: 0, stdout: "", stderr: "" };
    });
    await pasteboard("UDID", "café 日本 ✓");
    expect(calls).toEqual([{ args: ["xcrun", "simctl", "pbcopy", "UDID"], input: "café 日本 ✓", env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } }]);
});
