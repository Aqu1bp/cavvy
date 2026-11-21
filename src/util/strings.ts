/**
 * A string of its own, equal to `s`. A slice of a long string can keep the whole of it alive (Bun 1.3.14 here: twenty
 * 2,000-character slices of 4 MB strings held 75 MB), so what's cut to be kept small is copied. A JSON round trip copies
 * exactly, lone surrogates too (a Buffer through UTF-8 wouldn't), at about 15 µs for 64K characters.
 */
export function ownCopy(s: string): string {
    return JSON.parse(JSON.stringify(s)) as string;
}
