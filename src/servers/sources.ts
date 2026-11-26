// Where this Cavvy's servers get their build.

import { appsOwn, appsOwnBuild, bundledBuildsDir, bundledSource, localSource, sourceRoot, type BuildSource } from "./build";
import { publishedSource } from "./published";

/**
 * Made from the checkout this Cavvy runs from; else the one it came with (the installed desktop app); else the one
 * Cavvy published for it. A Mac's build isn't one the app carries: on Apple silicon the app's own program is it, and
 * any other copy downloads the published one.
 */
export function buildSource(): BuildSource {
    if (sourceRoot()) return localSource();
    const dir = bundledBuildsDir();
    const published = publishedSource();
    const linux = dir ? bundledSource(dir) : published;
    const own = appsOwn();
    return {
        ...linux,
        build: (target, o) => (target !== "darwin-arm64" ? linux.build(target, o) : own ? appsOwnBuild(own, linux.id, o) : published.build(target, o)),
    };
}
