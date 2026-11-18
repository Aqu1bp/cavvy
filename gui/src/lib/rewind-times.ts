// When each prompt in the Rewind list was sent (components/RewindDialog.tsx): as under the prompt in the conversation
// (lib/format.ts promptTime), and with its seconds where the entry next to it would read the same, so prompts sent in
// the same minute (the same one sent three times, say) can be told apart. Only there: the rest stay as they read
// in the conversation.

import { promptTime } from "./format";

/** `promptTime`, to the second. Asked for only for the few entries that need it, as the dialog opens. */
export function promptTimeSeconds(ms: number, now = Date.now()): string {
    const d = new Date(ms);
    const today = new Date(now);
    const time = { hour: "numeric", minute: "2-digit", second: "2-digit" } as const;
    if (d.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(undefined, time).format(d);
    const year = d.getFullYear() !== today.getFullYear() ? { year: "numeric" } as const : {};
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...year, ...time }).format(d);
}

/** Each entry's time, in the list's order (undefined where it has none). */
export function rewindTimes(at: readonly (number | undefined)[], now = Date.now()): (string | undefined)[] {
    const plain = at.map((ms) => (ms === undefined ? undefined : promptTime(ms, now)));
    return at.map((ms, i) => {
        const p = plain[i];
        if (ms === undefined || p === undefined) return undefined;
        return p === plain[i - 1] || p === plain[i + 1] ? promptTimeSeconds(ms, now) : p;
    });
}
