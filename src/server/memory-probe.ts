// What the server's memory is made of, from inside it: for benches (scripts/bench-ramp.ts samples it beside each
// process's footprint), so a peak can be told apart as the JS heap, the allocator's (buffers, strings' storage, the
// runtime's own), or neither (compiled code, the binary). Only when asked. The plain reading costs about 1 ms; `types`
// walks the whole heap (53 ms at 1.5 million objects, measured) and is for the end of a run, not while it's timed.

import { heapSize, heapStats, memoryUsage } from "bun:jsc";
import type { ServerMemory } from "./protocol";

const MB = 1024 * 1024;
const mb = (n: number) => Math.round((n / MB) * 10) / 10;

export function serverMemory(o: { types?: boolean } = {}): ServerMemory {
    const m = process.memoryUsage();
    const alloc = memoryUsage();
    const h = o.types ? heapStats() : undefined;
    return {
        rssMB: mb(m.rss),
        heapMB: mb(heapSize()),
        mallocMB: mb(alloc.current),
        mallocPeakMB: mb(alloc.peak),
        arrayBuffersMB: mb(m.arrayBuffers),
        ...(h ? { objects: h.objectCount, extraMB: mb(h.extraMemorySize), types: Object.entries(h.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 20) } : {}),
    };
}
