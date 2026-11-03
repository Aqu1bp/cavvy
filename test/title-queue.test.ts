import { expect, test } from "bun:test";
import { numberedTitles, TitleQueue, titlesByNumber } from "../src/server/title-queue";

test("the first title goes at once; those asked while it runs go together after it, each with its own answer", async () => {
    const q = new TitleQueue();
    const asked: string[][] = [];
    let release: (() => void) | undefined;
    const ask = async (prompts: string[]) => {
        asked.push(prompts);
        if (asked.length === 1) await new Promise<void>((r) => (release = r));
        return prompts.map((p) => `Title for ${p}`);
    };
    const first = q.title("m", "a", ask);
    const later = [q.title("m", "b", ask), q.title("m", "c", ask)];
    // Another model's (or account's) aren't held up by it.
    const other = q.title("other", "d", ask);
    expect(await other).toBe("Title for d");
    release!();
    expect(await first).toBe("Title for a");
    expect(await Promise.all(later)).toEqual(["Title for b", "Title for c"]);
    expect(asked).toEqual([["a"], ["d"], ["b", "c"]]);
    // Nothing waiting now: the next goes at once, alone.
    expect(await q.title("m", "e", ask)).toBe("Title for e");
    expect(asked.at(-1)).toEqual(["e"]);
});

test("a request that fails fails those it asked for, and the queue goes on", async () => {
    const q = new TitleQueue();
    let release: (() => void) | undefined;
    let n = 0;
    const ask = async (prompts: string[]) => {
        if (++n === 1) {
            await new Promise<void>((r) => (release = r));
            throw new Error("no answer");
        }
        return prompts.map((p) => p.toUpperCase());
    };
    const first = q.title("m", "a", ask).catch((e: Error) => e.message);
    const second = q.title("m", "b", ask);
    release!();
    expect(await first).toBe("no answer");
    expect(await second).toBe("B");
});

test("several titles come back by number, whatever's around them; a missing one is missing", () => {
    expect(numberedTitles(["fix the login", "add tests"])).toBe('<session number="1">\nfix the login\n</session>\n\n<session number="2">\nadd tests\n</session>');
    expect(titlesByNumber("Here you go:\n1. Fix login redirect\n3) Speed up tests\nSession 4: Write docs\n", 4)).toEqual(["Fix login redirect", undefined, "Speed up tests", "Write docs"]);
});
