// What an MCP server asks of the user, shown with the question dialog both
// front ends already have: a form (elicitation), a link to open, or a request
// to use the session's model (sampling). Codex's elicitations come here too.

import { APP_TITLE } from "../config/paths";
import { McpError, type McpElicitResult, type McpInput, type McpSamplingParams } from "./client";
import type { Sampler } from "../tools/types";

export interface FormQuestion {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect?: boolean;
}

/** Ask several questions; undefined when the user dismissed them. */
export type AskQuestions = (questions: FormQuestion[]) => Promise<string[][] | undefined>;

/** The option that leaves an optional field of an MCP server's form empty. */
const LEAVE_EMPTY = "Leave empty";

interface FormField {
    key: string;
    question: string;
    options: FormQuestion["options"];
    multi: boolean;
    required: boolean;
    /** The option that leaves it empty (an optional field's), named so no answer of its own is taken for it. */
    skip?: string;
    /** The value for what was picked or typed; undefined when it isn't one. */
    parse(answer: string[]): unknown;
}

/**
 * An MCP elicitation's form (a flat object of strings, numbers, booleans and
 * enums, as MCP has them) as one question per field. Undefined for a schema
 * that isn't one.
 */
export function elicitationForm(schema: any): FormField[] | undefined {
    const props = schema?.properties;
    if (!schema || typeof schema !== "object" || (schema.type !== undefined && schema.type !== "object") || (props !== undefined && (typeof props !== "object" || Array.isArray(props)))) return undefined;
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required.filter((k: unknown) => typeof k === "string") : []);
    const out: FormField[] = [];
    for (const [key, s] of Object.entries<any>(props ?? {})) {
        if (!s || typeof s !== "object") return undefined;
        const req = required.has(key);
        const label = typeof s.title === "string" && s.title.trim() ? s.title.trim() : key;
        const question = `${label}${typeof s.description === "string" && s.description.trim() ? ` (${s.description.trim()})` : ""}${req ? "" : " (optional)"}`;
        // Choices: labels shown, values sent; something typed that isn't one of them isn't a value.
        const choices = (list: { value: string; label: string }[]) => (picked: string) => list.find((c) => c.label === picked)?.value ?? list.find((c) => c.value === picked)?.value;
        const enumOf = (x: any): { value: string; label: string }[] | undefined => {
            if (Array.isArray(x?.oneOf)) return x.oneOf.filter((o: any) => typeof o?.const === "string").map((o: any) => ({ value: o.const, label: typeof o.title === "string" ? o.title : o.const }));
            if (Array.isArray(x?.anyOf)) return x.anyOf.filter((o: any) => typeof o?.const === "string").map((o: any) => ({ value: o.const, label: typeof o.title === "string" ? o.title : o.const }));
            if (Array.isArray(x?.enum)) return x.enum.filter((v: unknown) => typeof v === "string").map((v: string, i: number) => ({ value: v, label: typeof x.enumNames?.[i] === "string" ? x.enumNames[i] : v }));
            return undefined;
        };
        const field = (options: FormQuestion["options"], multi: boolean, parse: (a: string[]) => unknown): FormField => {
            if (req) return { key, question, options, multi, required: req, parse };
            // Not a label of the field's own (an enum's "Leave empty").
            let skip = LEAVE_EMPTY;
            while (options.some((o) => o.label === skip)) skip = `${skip} (skip)`;
            return { key, question, options: [...options, { label: skip }], multi, required: req, parse, skip };
        };
        const defaults = s.default !== undefined && typeof s.default !== "object" ? [{ label: String(s.default), description: "the default" }] : [];
        if (s.type === "array") {
            const list = enumOf(s.items);
            if (!list) return undefined;
            const value = choices(list);
            out.push(
                field(list.map((c) => ({ label: c.label })), true, (a) => {
                    const v = a.map(value);
                    const n = v.length;
                    return v.every((x) => x !== undefined) && !(typeof s.minItems === "number" && n < s.minItems) && !(typeof s.maxItems === "number" && n > s.maxItems) ? v : undefined;
                }),
            );
        } else if (s.type === "string" && enumOf(s)) {
            const list = enumOf(s)!;
            const value = choices(list);
            out.push(field(list.map((c) => ({ label: c.label })), false, (a) => value(a[0]!)));
        } else if (s.type === "boolean") {
            out.push(field([{ label: "Yes" }, { label: "No" }], false, (a) => (/^(yes|y|true)$/i.test(a[0]!.trim()) ? true : /^(no|n|false)$/i.test(a[0]!.trim()) ? false : undefined)));
        } else if (s.type === "number" || s.type === "integer") {
            const integer = s.type === "integer";
            out.push(
                field(defaults, false, (a) => {
                    const n = Number(a[0]!.trim());
                    const inRange = !(typeof s.minimum === "number" && n < s.minimum) && !(typeof s.maximum === "number" && n > s.maximum);
                    return a[0]!.trim() && Number.isFinite(n) && (!integer || Number.isInteger(n)) && inRange ? n : undefined;
                }),
            );
        } else if (s.type === "string") {
            const fits = (v: string) => !(typeof s.minLength === "number" && v.length < s.minLength) && !(typeof s.maxLength === "number" && v.length > s.maxLength);
            out.push(field(defaults, false, (a) => (fits(a[0]!) ? a[0] : undefined)));
        } else return undefined;
    }
    return out;
}

/**
 * Show a server's form and collect the answers: accept with the content, or
 * decline (dismissed, a required field left empty, an answer the form
 * doesn't allow, or a form the dialog can't show; `warn` says why for the
 * last two).
 */
export async function askForm(intro: string, schema: unknown, ask: AskQuestions, warn: (message: string) => void, server?: string): Promise<McpElicitResult> {
    const form = elicitationForm(schema);
    if (!form) {
        warn(`Declined a request from ${server || "an MCP server"} for input: ${APP_TITLE} can't show its form.`);
        return { action: "decline" };
    }
    const questions = form.length ? form.map((f) => ({ question: `${intro}\n\n${f.question}`, options: f.options, multiSelect: f.multi })) : [{ question: intro, options: [{ label: "Accept" }, { label: "Decline" }] }];
    const answers = await ask(questions);
    if (!answers) return { action: "decline" };
    if (!form.length) return answers[0]?.[0] === "Accept" ? { action: "accept", content: {} } : { action: "decline" };
    const content: Record<string, unknown> = {};
    for (const [i, f] of form.entries()) {
        const picked = (answers[i] ?? []).filter((x) => f.skip === undefined || x !== f.skip);
        const value = picked.length ? f.parse(picked) : undefined;
        if (value === undefined && picked.length) {
            // Not an answer the form allows (typed outside its choices, out of range): not sent as one.
            warn(`Declined ${server ? `the ${server} MCP server's` : "an MCP server's"} form: the answer for "${f.key}" isn't one it allows.`);
            return { action: "decline" };
        }
        if (value === undefined) {
            if (f.required) return { action: "decline" };
            continue;
        }
        content[f.key] = value;
    }
    return { action: "accept", content };
}

/** How a front end asks the user and runs the model, for what MCP servers ask of it. */
export interface McpAsker {
    /** One question at a time (the UiBridge's askQuestion); undefined when dismissed. */
    askQuestion?(question: string, options: { label: string; description?: string }[], multi: boolean): Promise<string[] | undefined>;
    /** One completion on the session's model, for sampling: its text and the model's name. */
    sample?: Sampler;
    /** A warning for the user (a form that can't be shown). */
    warn?(message: string): void;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The text of a sampling message's content (one block or several); other kinds named, not sent. */
function samplingText(content: unknown): string {
    const blocks = Array.isArray(content) ? content : [content];
    return blocks
        .map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type ? `[${String(b.type)} omitted]` : ""))
        .filter(Boolean)
        .join("\n");
}

/** A sampling request as one prompt: a lone user message as it is, a conversation as a transcript. */
export function samplingPrompt(p: McpSamplingParams): string {
    const msgs = p.messages ?? [];
    if (msgs.length === 1 && msgs[0]!.role === "user") return samplingText(msgs[0]!.content);
    return msgs.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${samplingText(m.content)}`).join("\n\n");
}

/**
 * The McpInput for one server: forms and links go to the question dialog,
 * and sampling runs only after the user allows it. With no way to ask,
 * there's nothing to answer with (forms are declined, sampling refused).
 */
/** The server's token limit, within what a one-off request may ask for (the 2048 used when it gives none). */
export function samplingBudget(maxTokens: unknown): number {
    return typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens >= 1 ? Math.min(Math.floor(maxTokens), 32_000) : 2048;
}

/** A provider's stop reason as MCP names it (endTurn, maxTokens, stopSequence), others as they are. */
export function mcpStopReason(r: string | undefined): string {
    return r === undefined || r === "end_turn" ? "endTurn" : r === "max_tokens" ? "maxTokens" : r === "stop_sequence" ? "stopSequence" : r;
}

export function mcpInput(server: string, a: McpAsker): McpInput | undefined {
    const askOne = a.askQuestion?.bind(a);
    if (!askOne) return undefined;
    const ask: AskQuestions = async (qs) => {
        const out: string[][] = [];
        for (const q of qs) {
            const r = await askOne(q.question, q.options, Boolean(q.multiSelect));
            if (!r) return undefined;
            out.push(r);
        }
        return out;
    };
    const who = `The ${server} MCP server`;
    return {
        async elicit(p) {
            const intro = `${who} asks${p.message.trim() ? `: ${p.message.trim()}` : "."}`;
            if (p.mode === "url") {
                const r = await askOne(`${intro}\n\nOpen this link to continue: ${p.url}`, [{ label: "Done", description: "I opened the link and finished there" }, { label: "Decline" }], false);
                return !r ? { action: "cancel" } : r[0] === "Done" ? { action: "accept" } : { action: "decline" };
            }
            return askForm(intro, p.requestedSchema, ask, (m) => a.warn?.(m), server);
        },
        sample: a.sample
            ? async (p, signal) => {
                  const prompt = samplingPrompt(p);
                  const shown = clip(prompt.trim(), 800);
                  const r = await askOne(
                      `${who} wants to use your model${p.maxTokens ? ` (up to ${p.maxTokens} tokens)` : ""}.${p.systemPrompt ? `\n\nSystem prompt: ${clip(p.systemPrompt.trim(), 300)}` : ""}\n\n${shown}`,
                      [{ label: "Allow", description: "Runs this one request on the session's model" }, { label: "Deny" }],
                      false,
                  );
                  if (r?.[0] !== "Allow") throw new McpError("The user declined the sampling request", -1);
                  const out = await a.sample!(p.systemPrompt ?? "", prompt, signal, samplingBudget(p.maxTokens));
                  return { role: "assistant", content: { type: "text", text: out.text }, model: out.model, stopReason: mcpStopReason(out.stopReason) };
              }
            : undefined,
    };
}
