// What of a server's diagnostics to tell the model and the user: errors and
// warnings that are new since the last report on the file, matched by what
// they say rather than where (an edit above moves everything below it), and
// capped so a broken file can't flood the context.

import type { LspDiagnostic } from "./client";
import { redact } from "../util/redact";
import { sanitizeLine, stripAnsi } from "../ui/ansi";

export type Severity = "error" | "warning";

export interface DiagnosticItem {
    /** As shown: relative to the project. */
    path: string;
    /** 1-based. */
    line: number;
    col: number;
    severity: Severity;
    message: string;
    code?: string;
    source?: string;
}

/** A report on the files an edit touched: shown under the edit, and what the model reads. */
export interface DiagnosticReport {
    files: FileReport[];
    /** Problems left out by the caps. */
    omitted: number;
}

export interface FileReport {
    path: string;
    /** New since the last report on this file (all of them the first time). */
    items: DiagnosticItem[];
    /** New ones before the caps: newErrors + newWarnings. */
    total: number;
    newErrors: number;
    newWarnings: number;
    /** Ones reported before that are gone now. */
    fixed: number;
    /** Errors and warnings in the file now, new or not. */
    errors: number;
    warnings: number;
    /** Nothing was reported on it before. */
    first: boolean;
}

export const MAX_PER_FILE = 20;
export const MAX_PER_REPORT = 40;
export const MAX_MESSAGE = 300;

export function severityOf(d: LspDiagnostic): Severity | undefined {
    // A missing severity is the client's to interpret; servers that leave it out mean errors.
    const s = d.severity ?? 1;
    return s === 1 ? "error" : s === 2 ? "warning" : undefined;
}

/** What identifies a problem across edits. */
export function diagnosticKey(d: LspDiagnostic): string {
    return `${severityOf(d)}\u0000${d.source ?? ""}\u0000${d.code ?? ""}\u0000${d.message}`;
}

/** Errors and warnings only: errors first (the caps keep them), each in file order. */
export function relevant(list: LspDiagnostic[]): LspDiagnostic[] {
    return list
        .filter((d) => d && typeof d.message === "string" && severityOf(d) && d.range?.start)
        .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

function counts(list: LspDiagnostic[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const d of list) m.set(diagnosticKey(d), (m.get(diagnosticKey(d)) ?? 0) + 1);
    return m;
}

/**
 * New problems in `now` compared with `before` (undefined: never reported),
 * as a multiset, so a second copy of a known error still counts as new.
 */
export function compare(path: string, before: LspDiagnostic[] | undefined, nowAll: LspDiagnostic[]): FileReport {
    const now = relevant(nowAll);
    const left = before ? counts(relevant(before)) : new Map<string, number>();
    const fresh: LspDiagnostic[] = [];
    for (const d of now) {
        const k = diagnosticKey(d);
        const n = left.get(k) ?? 0;
        if (n > 0) left.set(k, n - 1);
        else fresh.push(d);
    }
    const fixed = before ? [...left.values()].reduce((a, b) => a + b, 0) : 0;
    const items = fresh.map((d) => toItem(path, d));
    return {
        path,
        items: items.slice(0, MAX_PER_FILE),
        total: items.length,
        newErrors: items.filter((i) => i.severity === "error").length,
        newWarnings: items.filter((i) => i.severity === "warning").length,
        fixed,
        errors: now.filter((d) => severityOf(d) === "error").length,
        warnings: now.filter((d) => severityOf(d) === "warning").length,
        first: !before,
    };
}

function toItem(path: string, d: LspDiagnostic): DiagnosticItem {
    const message = oneLine(d.message);
    return {
        path,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity: severityOf(d)!,
        message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message,
        ...(d.code !== undefined && d.code !== null && d.code !== "" ? { code: String(d.code) } : {}),
        ...(d.source ? { source: d.source } : {}),
    };
}

/** One line of plain text: a server's message can quote anything in the file, escape sequences included. */
function oneLine(s: string): string {
    return stripAnsi(sanitizeLine(s.replace(/\s*[\r\n]+\s*/g, " "))).trim();
}

/** Files with something to say, within the report's cap; undefined when there's nothing. */
export function buildReport(files: FileReport[]): DiagnosticReport | undefined {
    const shown = files.filter((f) => f.total > 0 || f.fixed > 0);
    if (!shown.length) return undefined;
    let room = MAX_PER_REPORT;
    let omitted = 0;
    const out = shown.map((f) => {
        const items = f.items.slice(0, room);
        room -= items.length;
        omitted += f.total - items.length;
        return { ...f, items };
    });
    return { files: out, omitted };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line on a file: "2 new errors, 1 new warning, 3 fixed". */
export function fileHeadline(f: FileReport): string {
    const parts: string[] = [];
    const adj = f.first ? "" : "new ";
    if (f.newErrors) parts.push(`${f.newErrors} ${adj}${f.newErrors === 1 ? "error" : "errors"}`);
    if (f.newWarnings) parts.push(`${f.newWarnings} ${adj}${f.newWarnings === 1 ? "warning" : "warnings"}`);
    if (f.fixed) parts.push(`${f.fixed} fixed`);
    return parts.join(", ");
}

export function itemLine(i: DiagnosticItem): string {
    const tag = [i.source, i.code].filter(Boolean).join(" ");
    return `${i.line}:${i.col} ${i.severity}${tag ? ` [${tag}]` : ""}: ${i.message}`;
}

/** What the model reads, after the tool's own result. */
export function formatForModel(r: DiagnosticReport): string {
    const out: string[] = ["<new-diagnostics>", "The language server reports these problems after this change. Fix the errors you caused before moving on; ignore ones unrelated to your task."];
    for (const f of r.files) {
        out.push(`${f.path}: ${fileHeadline(f) || "no new problems"}`);
        for (const i of f.items) out.push(`  ${itemLine(i)}`);
        const cut = f.total - f.items.length;
        if (cut > 0) out.push(`  … and ${cut} more`);
    }
    if (r.files.every((f) => !f.items.length)) out[1] = "The language server reports problems resolved by this change.";
    out.push("</new-diagnostics>");
    return out.join("\n");
}

/** The short summary for the UI: "1 error · 2 warnings" or "2 problems fixed". */
export function summaryLine(r: DiagnosticReport): string {
    const errors = r.files.reduce((a, f) => a + f.newErrors, 0);
    const warnings = r.files.reduce((a, f) => a + f.newWarnings, 0);
    const fixed = r.files.reduce((a, f) => a + f.fixed, 0);
    const parts: string[] = [];
    if (errors) parts.push(plural(errors, "error"));
    if (warnings) parts.push(plural(warnings, "warning"));
    if (fixed) parts.push(`${fixed} fixed`);
    return parts.join(" · ");
}

/** The report with secrets taken out of its messages (a string literal can hold one), for windows and logs. */
export function redactedReport(r: DiagnosticReport): DiagnosticReport {
    return { ...r, files: r.files.map((f) => ({ ...f, items: f.items.map((i) => ({ ...i, message: redact(i.message) })) })) };
}
