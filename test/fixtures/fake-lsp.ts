// A language server for tests. Each line of a document holding "ERROR: msg"
// or "WARN: msg" is a diagnostic at that line; "HINT: msg" is a hint.
// Behaviour by env:
//   FAKE_LSP_LOG           append every message it receives (one JSON per line)
//   FAKE_LSP_DELAY         ms before publishing
//   FAKE_LSP_SILENT_CLEAN  say nothing when a clean file stays clean (as typescript-language-server does)
//   FAKE_LSP_STAGES        publish an empty list first, then the real one
//   FAKE_LSP_VERSION       include the document version
//   FAKE_LSP_NO_INIT       never answer initialize
//   FAKE_LSP_INIT_DELAY    ms before answering initialize (a slow start)
//   FAKE_LSP_CROSS         a line "BREAKS: <file>" also publishes an error for that file (a sibling)
//   FAKE_LSP_STDERR        write this much junk to stderr at start (bytes)
//   FAKE_LSP_PULL          answer textDocument/diagnostic (LSP 3.17 pull) and push nothing; "fail" refuses the requests,
//                          "cancel-first" cancels the first one (ServerCancelled, as pyright does when a change overtakes it)
//   FAKE_LSP_TSSERVER      answer typescript-language-server's tsserverRequest command, in tsserver's format
// A document containing "CRASH" makes it exit with code 3.

import { appendFileSync } from "fs";

const env = process.env;
const log = env.FAKE_LSP_LOG;
const delay = Number(env.FAKE_LSP_DELAY ?? 0);
const lastCount = new Map<string, number>();
const texts = new Map<string, string>();
let cancelledOne = false;
let buf = Buffer.alloc(0);

if (env.FAKE_LSP_STDERR) process.stderr.write("x".repeat(Number(env.FAKE_LSP_STDERR)));

function send(msg: unknown) {
    const body = Buffer.from(JSON.stringify(msg));
    process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function diagnosticsOf(text: string) {
    const out: unknown[] = [];
    text.split("\n").forEach((line, i) => {
        for (const [tag, severity] of [["ERROR:", 1], ["WARN:", 2], ["HINT:", 4]] as const) {
            const at = line.indexOf(tag);
            if (at >= 0) out.push({ range: { start: { line: i, character: at }, end: { line: i, character: line.length } }, severity, source: "fake", code: tag.slice(0, -1).toLowerCase(), message: line.slice(at + tag.length).trim() });
        }
    });
    return out;
}

function publish(uri: string, version: number, text: string) {
    texts.set(uri, text);
    if (text.includes("CRASH")) process.exit(3);
    if ((env.FAKE_LSP_PULL && env.FAKE_LSP_PULL !== "fail") || env.FAKE_LSP_TSSERVER) return;
    const diagnostics = diagnosticsOf(text);
    const before = lastCount.get(uri) ?? -1;
    lastCount.set(uri, diagnostics.length);
    if (env.FAKE_LSP_SILENT_CLEAN && diagnostics.length === 0 && before === 0) return;
    const go = () => {
        if (env.FAKE_LSP_STAGES) send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
        const stage = () => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics, ...(env.FAKE_LSP_VERSION ? { version } : {}) } });
        if (env.FAKE_LSP_STAGES) setTimeout(stage, 40);
        else stage();
        if (env.FAKE_LSP_CROSS) {
            for (const m of text.matchAll(/BREAKS: (\S+)/g)) {
                const other = new URL(m[1]!, uri).href;
                send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: other, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: `broken by ${uri.split("/").pop()}` }] } });
            }
        }
    };
    if (delay) setTimeout(go, delay);
    else go();
}

async function handle(msg: { id?: number; method?: string; params?: any }) {
    if (log) appendFileSync(log, JSON.stringify({ method: msg.method, id: msg.id }) + "\n");
    switch (msg.method) {
        case "initialize":
            if (env.FAKE_LSP_NO_INIT) return;
            if (env.FAKE_LSP_INIT_DELAY) await Bun.sleep(Number(env.FAKE_LSP_INIT_DELAY));
            // Ask the client something, as real servers do.
            send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
            return send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                    capabilities: {
                        textDocumentSync: 1,
                        ...(env.FAKE_LSP_PULL ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } : {}),
                        ...(env.FAKE_LSP_TSSERVER ? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } } : {}),
                    },
                },
            });
        case "textDocument/diagnostic": {
            if (env.FAKE_LSP_PULL === "fail") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
            if (env.FAKE_LSP_PULL === "cancel-first" && !cancelledOne) {
                cancelledOne = true;
                return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32802, message: "cancelled" } });
            }
            const uri = msg.params.textDocument.uri as string;
            const items = diagnosticsOf(texts.get(uri) ?? "");
            // Pulled, a sibling's "BREAKS: <this file>" shows up as an error here.
            if (env.FAKE_LSP_CROSS) {
                for (const [other, t] of texts) if (other !== uri && t.split("\n").some((l) => l === `BREAKS: ${uri.split("/").pop()}`)) items.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: `broken by ${other.split("/").pop()}` });
            }
            const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { kind: "full", items } });
            return delay ? void setTimeout(reply, delay) : reply();
        }
        case "workspace/executeCommand": {
            const [command, args] = msg.params.arguments;
            const uri = new URL(`file://${args.file}`).href;
            const text = texts.get(uri) ?? "";
            const all = diagnosticsOf(text) as { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity: number; message: string }[];
            const cat = ["", "error", "warning", "message", "suggestion"];
            const body = all
                .filter((d) => (command === "syntacticDiagnosticsSync" ? d.message.startsWith("syntax") : !d.message.startsWith("syntax")))
                .map((d) => ({ message: d.message, category: cat[d.severity], code: 2322, startLocation: { line: d.range.start.line + 1, offset: d.range.start.character + 1 }, endLocation: { line: d.range.end.line + 1, offset: d.range.end.character + 1 } }));
            return send({ jsonrpc: "2.0", id: msg.id, result: { seq: 0, type: "response", command, success: true, body } });
        }
        case "textDocument/didOpen":
            return publish(msg.params.textDocument.uri, msg.params.textDocument.version, msg.params.textDocument.text);
        case "textDocument/didClose":
            texts.delete(msg.params.textDocument.uri);
            return;
        case "textDocument/didChange":
            return publish(msg.params.textDocument.uri, msg.params.textDocument.version, msg.params.contentChanges[0].text);
        case "shutdown":
            return send({ jsonrpc: "2.0", id: msg.id, result: null });
        case "exit":
            return process.exit(0);
    }
}

process.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())?.[1]);
        if (buf.length < end + 4 + len) return;
        const body = buf.subarray(end + 4, end + 4 + len).toString();
        buf = buf.subarray(end + 4 + len);
        handle(JSON.parse(body));
    }
});
process.stdin.on("end", () => process.exit(0));
