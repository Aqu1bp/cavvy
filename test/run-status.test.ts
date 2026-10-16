import { expect, test } from "bun:test";
import { runStatus } from "../gui/src/lib/run-status";

test("an interrupted run session stays stopped when only its saved summary is available", () => {
    expect(runStatus("idle", "stopped")).toEqual({ word: "stopped", tone: "stopped" });
    expect(runStatus("idle", "done")).toEqual({ word: "done", tone: "done" });
    expect(runStatus("idle")).toEqual({ word: "done", tone: "done" });
    expect(runStatus("error", "done")).toEqual({ word: "stopped", tone: "stopped" });
});

test("a resumed run reports current activity before its old saved outcome", () => {
    expect(runStatus("running", "stopped")).toEqual({ word: "working", tone: "running" });
    expect(runStatus("waiting", "stopped")).toEqual({ word: "needs you", tone: "waiting" });
});
