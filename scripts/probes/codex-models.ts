// Lists Codex's models (model/list) so the other Codex probes can pick the cheapest. Prints id, effort levels, default flag.
//   bun scripts/probes/codex-models.ts
import { Log, fixture } from "./lib";
import { startCodex } from "./codex-lib";

const log = new Log(fixture("codex-model-list"));
const c = startCodex(log);
const init = await c.handshake();
log.note(`initialize -> ${init.error ? JSON.stringify(init.error) : "ok"}`);
const r = await c.request("model/list", {});
for (const m of r.result?.data ?? []) console.log(m.model, "hidden=" + m.hidden, "default=" + m.isDefault, "efforts=" + (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort).join("/"), m.displayName, "-", m.description);
await c.stop();
