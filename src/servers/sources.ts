// Where this Cavvy's servers get their build.

import { bundledBuildsDir, bundledSource, localSource, sourceRoot, type BuildSource } from "./build";
import { publishedSource } from "./published";

/**
 * Made from the checkout this Cavvy runs from; else the one it came with (the installed desktop app); else the one
 * Cavvy published for it.
 */
export function buildSource(): BuildSource {
    if (sourceRoot()) return localSource();
    const dir = bundledBuildsDir();
    return dir ? bundledSource(dir) : publishedSource();
}
