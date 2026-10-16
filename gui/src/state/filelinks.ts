// The GUI's one PathCache (lib/pathcache.ts): asks the server with fs.exists,
// and bumps a signal when answers arrive or are forgotten, so replies still
// waiting on paths render again.

import { createSignal } from "solid-js";
import { PathCache } from "../lib/pathcache";
import { rpc } from "./app";

export const paths = new PathCache({ ask: (sessionId, list) => rpc.call("fs.exists", { sessionId, paths: list }) });

const [version, setVersion] = createSignal(0);
export const linksVersion = version;
paths.onChange(() => setVersion((v) => v + 1));
