// @-mention completion in a repository of a million files (src/ui/mention-shards.ts): how long each keystroke takes
// on the workers, how long the server's own thread is held meanwhile, and that it offers what one index would.
//
//   bun scripts/mention-bench.ts [workers]
//
// The paths are made up (a million, 38 MB listed), the same each run.
import { MentionShards, mentionSharding } from "../src/ui/mention-shards";
import { PathIndex } from "../src/ui/path-index";

const words = "src lib components server agent tools util test fixtures docs app core api client model view store index main config build scripts assets styles".split(" ");
function made(): string[] {
    let seed = 3;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const files: string[] = [];
    for (let i = 0; i < 1_000_000; i++) {
        const parts = Array.from({ length: 2 + Math.floor(r() * 5) }, () => words[Math.floor(r() * words.length)]!);
        files.push(`${parts.join("/")}/${words[Math.floor(r() * words.length)]}_${i}.ts`);
    }
    return files;
}
const listing = new TextEncoder().encode(made().join("\n") + "\n");
// Only the listing kept here, as the server keeps it.
Bun.gc(true);
if (process.argv[2]) mentionSharding.most = Number(process.argv[2]);

let held = 0;
let last = performance.now();
let ticking = true;
const tick = () => {
    const now = performance.now();
    held = Math.max(held, now - last);
    last = now;
    if (ticking) setImmediate(tick);
};
setImmediate(tick);

const shards = new MentionShards();
let at = performance.now();
await shards.take(listing);
const indexMs = performance.now() - at;
const heldIndexing = held;
held = 0;
const queries = ["c", "co", "com", "comp", "x", "onent", "ts", "e", "o", "srvidx", "main_4242", "42", "dex", "nd", "ture", "_1", "z"];
// Once to warm up, then measured.
for (const q of queries) await shards.search(q, 12);
const ms: Record<string, number> = {};
for (const q of queries) {
    at = performance.now();
    await shards.search(q, 12);
    ms[q] = Math.round(performance.now() - at);
}
const heldSearching = held;
ticking = false;
const one = new PathIndex();
void one.take(made());
const differ: string[] = [];
for (const q of queries) if (JSON.stringify(await shards.search(q, 12)) !== JSON.stringify(one.find(q, 12))) differ.push(q);
const sorted = Object.values(ms).sort((a, b) => a - b);
console.log(JSON.stringify({
    bun: Bun.version, workers: Math.min(mentionSharding.most, Math.ceil(listing.length / mentionSharding.perPart)), indexMs: Math.round(indexMs),
    heldMs: { indexing: +heldIndexing.toFixed(1), searching: +heldSearching.toFixed(1) },
    keystrokeMs: { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), each: ms }, differ,
}));
shards.stop();
process.exit(0);
