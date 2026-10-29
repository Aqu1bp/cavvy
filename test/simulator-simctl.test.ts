// What simctl says (src/simulator/simctl.ts): the devices that can run, in the order the pane and the agent list them,
// and its errors without their boilerplate.
import { expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { keyboardOf, launch, parseDevices, pasteboard, runningFor, runtimeName, setRunner, simctlError, typesAsUS } from "../src/simulator/simctl";

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
    // Why, when it says, follows what failed; the underlying error repeats it.
    const install = "An error was encountered processing the command (domain=IXErrorDomain, code=13):\nSimulator device failed to install the application.\nMissing bundle ID.\nUnderlying error (domain=IXErrorDomain, code=13):\n\tFailed to get bundle ID from /tmp/Bad.app\n\tMissing bundle ID.\n";
    expect(simctlError(install)).toBe("Simulator device failed to install the application. Missing bundle ID.");
});

test("an app that's running comes to the front as it is; only a restart ends it first", async () => {
    const calls: string[][] = [];
    setRunner(async (args) => {
        calls.push(args);
        if (args[0] === "ps") return { code: 0, stdout: args.at(-1) === "11" ? "  1-02:03:04\n" : args.at(-1) === "12" ? "   07:13\n" : "", stderr: "" };
        return { code: 0, stdout: "com.example.app: 11\n", stderr: "" };
    });
    expect(await launch("U", "com.example.app", ["-x"])).toBe(11);
    expect(await launch("U", "com.example.app", [], { restart: true })).toBe(11);
    expect(calls.map((c) => c.slice(2).join(" "))).toEqual(["launch U com.example.app -x", "launch --terminate-running-process U com.example.app"]);
    expect(await runningFor(11)).toBe(93784);
    expect(await runningFor(12)).toBe(433);
    expect(await runningFor(13)).toBeUndefined();
});

test("keys type as a U.S. keyboard's only where the device's keyboard has that layout", async () => {
    expect(typesAsUS("en_US@sw=QWERTY;hw=Automatic")).toBe(true);
    expect(typesAsUS("en_US@sw=QWERTY;hw=U.S.")).toBe(true);
    expect(typesAsUS("de_DE@sw=QWERTZ-German;hw=Automatic")).toBe(false);
    expect(typesAsUS("en_US@sw=QWERTY;hw=German")).toBe(false);
    expect(typesAsUS("ar@sw=Arabic;hw=Automatic")).toBe(false);
    expect(typesAsUS("en_GB@sw=QWERTY;hw=Automatic")).toBe(false);
    expect(typesAsUS(undefined)).toBe(true);
    // The keyboard in use, else the first one set up.
    const asked: string[] = [];
    setRunner(async (args) => {
        asked.push(args[2]!);
        return args[2] === "KeyboardsCurrentAndNext.0" ? { code: 1, stdout: "", stderr: "no value" } : { code: 0, stdout: "de_DE@sw=QWERTZ-German;hw=Automatic\n", stderr: "" };
    });
    expect(await keyboardOf("U")).toBe("de_DE@sw=QWERTZ-German;hw=Automatic");
    expect(asked).toEqual(["KeyboardsCurrentAndNext.0", "AppleKeyboards.0"]);
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
