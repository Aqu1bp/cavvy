// lib/keyed-list.ts against Solid's own mapArray, on random lists: the same items kept, made and let go of at each
// step, in the same order. (That it doesn't keep what's let go of is measured in Chrome, whose heap is what matters:
// this runtime's collector keeps them with Solid's own mapArray too.)
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

// The module, on the same Solid as the test's (a test run without the browser condition would give it Solid's
// server build, whose owners aren't these).
const source = readFileSync(new URL("../gui/src/lib/keyed-list.ts", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const { mapList } = new Function(...Object.keys(solid), `${new Bun.Transpiler({ loader: "ts" }).transformSync(source)}; return { mapList };`)(...Object.values(solid)) as typeof import("../gui/src/lib/keyed-list");

function run(map: typeof mapList, steps: string[][]) {
    const log: string[] = [];
    let n = 0;
    const [list, setList] = solid.createSignal<string[]>([]);
    let out: () => unknown[] = () => [];
    const dispose = solid.createRoot((d) => {
        out = solid.createMemo(map(list as () => string[], (item: string) => {
            const made = `${item}#${n++}`;
            log.push(`+${made}`);
            solid.onCleanup(() => log.push(`-${made}`));
            return made as never;
        })) as () => unknown[];
        return d;
    });
    const shown: string[][] = [];
    for (const s of steps) {
        setList(s);
        shown.push([...(out() as string[])]);
    }
    dispose();
    return { log, shown };
}

const solidMap = (list: () => string[], fn: (item: string) => unknown) => solid.mapArray(list, fn as never) as unknown as () => unknown[];

test("keeps, makes and lets go of the same items as Solid's <For>, in the same order", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const pool = Array.from({ length: 30 }, (_, i) => `t${i}`);
    for (let trial = 0; trial < 300; trial++) {
        const steps: string[][] = [];
        let cur: string[] = [];
        for (let k = 0; k < 12; k++) {
            const op = rnd();
            if (op < 0.25) cur = [...pool.filter(() => rnd() < 0.3)];
            else if (op < 0.45) cur = [...pool.slice(0, Math.floor(rnd() * 8)).filter((x) => !cur.includes(x)), ...cur];
            else if (op < 0.6) cur = cur.slice(Math.floor(rnd() * cur.length));
            else if (op < 0.7) cur = [...cur].reverse();
            else if (op < 0.8) cur = [...cur, pool[Math.floor(rnd() * pool.length)]!];
            else if (op < 0.9) cur = cur.filter(() => rnd() < 0.7);
            else cur = [];
            steps.push(cur);
        }
        const ours = run(mapList as never, steps);
        const theirs = run(solidMap as never, steps);
        expect(ours.shown).toEqual(theirs.shown);
        expect(ours.log).toEqual(theirs.log);
    }
});
