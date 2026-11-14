export function splitPair(original: string, added: string, current?: readonly [string, string]): readonly [string, string] | undefined {
    if (added === original || current?.includes(added)) return current;
    return [current?.[0] ?? original, added];
}
