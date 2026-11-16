import { expect, test } from "bun:test";
import { serverMemory } from "../src/server/memory-probe";

test("the server says what its memory is made of, cheaply unless the heap's kinds are asked for", () => {
    Bun.gc(true);
    const plain = serverMemory();
    expect(plain.heapMB).toBeGreaterThan(0);
    expect(plain.mallocMB).toBeGreaterThan(0);
    expect(plain.mallocPeakMB).toBeGreaterThanOrEqual(plain.mallocMB);
    expect(plain.types).toBeUndefined();
    const full = serverMemory({ types: true });
    expect(full.objects).toBeGreaterThan(0);
    expect(full.types!.length).toBeGreaterThan(0);
});
