// The file the Review pane is asked to show. A name that hides a registered value is shown redacted, and two can
// show the same; such a file is named by its handle (GitFileDiff.pathToken) too. The handle is never a file name:
// requests carry it as `pathToken` (a file can be named "git:…"), and only the name is ever shown.

export interface ReviewPick {
    /** As shown: what the header says while it loads, or if it can't be found. */
    path: string;
    token?: string;
}

/** A listed file, as a pick. */
export const pickOf = (f: { path: string; pathToken?: string }): ReviewPick => (f.pathToken ? { path: f.path, token: f.pathToken } : { path: f.path });

/** What a request for it carries: its handle when it has one, else its name. */
export const pickParams = (p: ReviewPick): { path?: string; pathToken?: string } => (p.token ? { pathToken: p.token } : { path: p.path });

/** One pick from another, as a key: the same file is the same key. */
export const pickKey = (p: ReviewPick): string => JSON.stringify([p.path, p.token ?? null]);

/**
 * Which listed file it is: by handle; by name, among files without one first (a file can be literally named like a
 * redacted one); then, by the name shown (a turn card names it so), the one handled file shown so. Two or more shown
 * alike are none of them: guessing could show the wrong file's diff.
 */
export function findPick<F extends { path: string; pathToken?: string }>(files: readonly F[], p: ReviewPick, same: (a: string, b: string) => boolean): F | undefined {
    if (p.token) return files.find((f) => f.pathToken === p.token);
    const literal = files.find((f) => !f.pathToken && same(f.path, p.path));
    if (literal) return literal;
    const shownSo = files.filter((f) => f.pathToken && same(f.path, p.path));
    return shownSo.length === 1 ? shownSo[0] : undefined;
}
