// A list mapped to what each of its items shows, kept by item (as Solid's <For>), for a list that grows and shrinks
// by many at a time: the conversation's turns ("Show earlier", and let go of again back at the end).
//
// Adapted from Solid's mapArray (solid-js 1.9, MIT License, Copyright (c) 2016-2025 Ryan Carniato), with two changes.
// Solid's keeps each item's disposer in an array it never shortens, and builds each item in a closure over the whole
// list as it was then: an item let go of (its disposer left past the list's end) or one made when the list was long
// kept that whole list, and every turn in it, for as long as the view lasted (115 turns of a long session no longer
// shown, 4.5 MB, after four pages read up and back). Here the disposers go with their items, and each item is made
// from itself alone.

import { $TRACK, createMemo, createRoot, onCleanup, untrack, type JSX } from "solid-js";

export function mapList<T>(list: () => readonly T[] | undefined, mapFn: (item: T) => JSX.Element): () => JSX.Element[] {
    let items: T[] = [];
    let mapped: JSX.Element[] = [];
    let disposers: (() => void)[] = [];
    onCleanup(() => {
        for (const d of disposers) d();
        disposers = [];
    });
    /**
     * One item made, in a root of its own: from the item alone (see above). The root keeps what it was made with, so
     * that's only the item: not the list, nor the array its disposer goes in.
     */
    const make = (item: T, into: (() => void)[], at: number) => {
        let disposer!: () => void;
        const made = createRoot((dispose) => {
            disposer = dispose;
            return mapFn(item);
        });
        into[at] = disposer;
        return made;
    };
    return () => {
        const newItems = list() ?? [];
        (newItems as unknown as Record<symbol, unknown>)[$TRACK];
        return untrack(() => {
            const newLen = newItems.length;
            const len = items.length;
            if (newLen === 0) {
                for (const d of disposers) d();
                items = [];
                mapped = [];
                disposers = [];
                return mapped;
            }
            if (len === 0) {
                const nextDisposers: (() => void)[] = new Array(newLen);
                mapped = newItems.map((item, j) => make(item, nextDisposers, j));
                disposers = nextDisposers;
                items = newItems.slice();
                return mapped;
            }
            const temp: JSX.Element[] = new Array(newLen);
            const tempDisposers: (() => void)[] = new Array(newLen);
            let start = 0;
            const end0 = Math.min(len, newLen);
            while (start < end0 && items[start] === newItems[start]) start++;
            let end = len - 1;
            let newEnd = newLen - 1;
            for (; end >= start && newEnd >= start && items[end] === newItems[newEnd]; end--, newEnd--) {
                temp[newEnd] = mapped[end];
                tempDisposers[newEnd] = disposers[end]!;
            }
            // Where each item still in the list is now (an item twice: each in turn).
            const newIndices = new Map<T, number>();
            const newIndicesNext: number[] = new Array(newEnd + 1);
            for (let j = newEnd; j >= start; j--) {
                const item = newItems[j]!;
                const i = newIndices.get(item);
                newIndicesNext[j] = i === undefined ? -1 : i;
                newIndices.set(item, j);
            }
            for (let i = start; i <= end; i++) {
                const item = items[i]!;
                const j = newIndices.get(item);
                if (j !== undefined && j !== -1) {
                    temp[j] = mapped[i];
                    tempDisposers[j] = disposers[i]!;
                    newIndices.set(item, newIndicesNext[j]!);
                } else disposers[i]!();
            }
            const nextDisposers: (() => void)[] = new Array(newLen);
            const nextMapped: JSX.Element[] = new Array(newLen);
            for (let j = 0; j < newLen; j++) {
                if (j < start) {
                    nextMapped[j] = mapped[j];
                    nextDisposers[j] = disposers[j]!;
                } else if (j in temp) {
                    nextMapped[j] = temp[j];
                    nextDisposers[j] = tempDisposers[j]!;
                } else nextMapped[j] = make(newItems[j]!, nextDisposers, j);
            }
            mapped = nextMapped;
            disposers = nextDisposers;
            items = newItems.slice();
            return mapped;
        });
    };
}

/** <For each={…}>{(item) => …}</For>, made with mapList. */
export function KeyedList<T>(props: { each: readonly T[] | undefined; children: (item: T) => JSX.Element }): JSX.Element {
    const map = props.children;
    return createMemo(mapList(() => props.each, map)) as unknown as JSX.Element;
}
