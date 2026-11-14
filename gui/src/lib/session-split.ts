export function splitPair(original: string, added: string, current?: readonly [string, string]): readonly [string, string] | undefined {
    if (added === original || current?.includes(added)) return current;
    return [current?.[0] ?? original, added];
}

/** Keep both composers usable; a narrower window gives each half the room. */
export function clampSplitRatio(ratio: number, width: number): number {
    if (!Number.isFinite(ratio) || !Number.isFinite(width) || width <= 0) return 0.5;
    const minimum = Math.min(0.5, 320 / width);
    return Math.max(minimum, Math.min(1 - minimum, ratio));
}
