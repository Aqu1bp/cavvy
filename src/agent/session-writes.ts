// Which session files this process has written to, in order: a listing reused while no folder changed (an append
// doesn't change its folder's time) looks at those again, wherever they were in it. Another process's write is seen
// by the listing's next whole relisting.

const written = new Map<string, number>();
let writes = 0;

export function noteSessionWrite(file: string): void {
    written.set(file, ++writes);
}

/** Writes so far: a listing keeps this, and asks what was written after it. */
export function sessionWriteCount(): number {
    return writes;
}

/** The files written to after `count` writes (none when there were none since: no work). */
export function writtenAfter(count: number): ReadonlySet<string> | undefined {
    if (count >= writes) return undefined;
    const out = new Set<string>();
    for (const [file, n] of written) if (n > count) out.add(file);
    return out;
}
