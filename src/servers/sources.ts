// Where this Cavvy's servers get their build.

import { bundledBuildsDir, bundledSource, localSource, sourceRoot, type BuildSource } from "./build";

/**
 * Made from the checkout this Cavvy runs from; else the one it came with (the installed desktop app). A Cavvy with
 * neither can't make one, and says so when asked to.
 */
export function buildSource(): BuildSource {
    if (sourceRoot()) return localSource();
    const dir = bundledBuildsDir();
    return dir ? bundledSource(dir) : localSource();
}
