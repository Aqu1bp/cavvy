// A command that only waits shows as a wait against its length ("Waiting 1m 40s of 4m 40s"); anything else runs as usual.

import { describe, expect, test } from "bun:test";
import { sleepSeconds } from "../gui/src/lib/format";

describe("sleepSeconds", () => {
    test("a plain wait, with or without a unit or a closing echo", () => {
        expect(sleepSeconds("sleep 240")).toBe(240);
        expect(sleepSeconds("sleep 280; echo done")).toBe(280);
        expect(sleepSeconds("  sleep 1.5 && echo ok  ")).toBe(1.5);
        expect(sleepSeconds("sleep 4m")).toBe(240);
        expect(sleepSeconds("sleep 2h; echo")).toBe(7200);
        expect(sleepSeconds("sleep 30s;")).toBe(30);
    });

    test("anything that does more than wait isn't one", () => {
        expect(sleepSeconds("sleep 5; bun test")).toBeUndefined();
        expect(sleepSeconds("sleep 5 && rm -rf build")).toBeUndefined();
        expect(sleepSeconds("sleep 5; echo $(date)")).toBeUndefined();
        expect(sleepSeconds("sleep 5 | cat")).toBeUndefined();
        expect(sleepSeconds("sleep 5\necho done")).toBeUndefined();
        expect(sleepSeconds("until curl -s localhost; do sleep 1; done")).toBeUndefined();
        expect(sleepSeconds("sleep 0")).toBeUndefined();
        expect(sleepSeconds("sleep infinity")).toBeUndefined();
        expect(sleepSeconds(undefined)).toBeUndefined();
    });
});
