// The fakes' log is read while they write it (test/helpers/fake-env.ts fakeLog).

import { expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fakeLog } from "./helpers/fake-env";
import { tempDir } from "./helpers/isolate";

test("a line the fake is partway through writing is left for the next read", () => {
    const log = join(tempDir("fake-log-"), "log.jsonl");
    expect(fakeLog(log)).toEqual([]);
    writeFileSync(log, '{"argv":["-p"]}\n{"received":{"type":"us');
    expect(fakeLog(log)).toEqual([{ argv: ["-p"] }]);
    appendFileSync(log, 'er"}}\n');
    expect(fakeLog(log)).toEqual([{ argv: ["-p"] }, { received: { type: "user" } }]);
});
