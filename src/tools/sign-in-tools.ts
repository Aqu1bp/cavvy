// RequestSignIn: the agent asks the user to sign in to something, and Cavvy
// runs that sign-in. A sibling of AskUserQuestion and RequestSecret: the call
// waits for the user. The agent names what and where, never a command to run;
// it gets back whether it's signed in and as whom, and nothing else.

import type { ServerTool, ServerToolResult } from "../mcp/server";
import { offeredCommandError, type SignInAnswer, type SignInRequest } from "../agent/sign-ins";
import { signedOutIn, type SignInRecipe } from "../agent/sign-in-recipes";
import { MCP_SERVER_NAME } from "../agent/delegation";
import type { Tool } from "./types";

type Input = { target: string; machine?: string; command?: string };

const TARGET = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,39}$/;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

function inputError(i: Record<string, unknown>): string | undefined {
    if (typeof i.target !== "string" || !TARGET.test(i.target.trim())) return "target must name what to sign in to: gh, aws, gcloud, claude, codex, or another CLI by its command name.";
    if (i.machine !== undefined && (typeof i.machine !== "string" || !MACHINE.test(i.machine.trim()))) return "machine must be a server's name as Cavvy lists it, or left out for this machine.";
    if (i.command !== undefined) return offeredCommandError(i.target, i.command);
    return undefined;
}

const request = (i: Input, tool: string, waitMs?: number): SignInRequest => ({ targets: [{ target: i.target.trim(), command: i.command?.trim() }], machine: i.machine?.trim() || undefined, tool, waitMs });

const NOBODY = "Can't ask the user to sign in: no one is here to do it (non-interactive session). Say what needs signing in and stop, or carry on with what doesn't need it.";

const DESCRIPTION = `Asks the user to sign in to a CLI or service when something needs it: a command failed because it isn't signed in (gh, aws, gcloud, an agent CLI on a server), or work ahead will need it. Cavvy runs the sign-in itself and shows the user a card with what they have to do (a link, a code, a field). Call this instead of telling the user to run a login command and stopping.

- target is what to sign in to: gh (GitHub), aws, gcloud (Google Cloud), claude (Claude Code), codex, or a sign-in the user has saved. You never pass a command to run: Cavvy decides what runs.
- machine is the name of one of the user's servers, to sign in there. Leave it out for the machine this session runs on.
- The call waits until the user is done, then you carry on in the same turn (run the push again, and so on). You get back "signed in" and as whom, or that it isn't; never codes, tokens or what the sign-in printed.
- If it's already signed in, you're told so at once and the user sees nothing.
- If the user chooses Later, do what doesn't need the sign-in and say what's left. Cavvy tells you when they sign in. Don't ask again in the same turn; when something they ask for later needs it, ask then.
- If you're told the request is still waiting, end your turn: Cavvy tells you when they've signed in.
- command is only for a CLI Cavvy says it has no sign-in for: that CLI's own sign-in command ("fly auth login"), starting with the target. The user is shown it and runs it themselves.
- Not for API keys or passwords a command reads from its environment: that's RequestSecret.`;

export const RequestSignInTool: Tool<Input> = {
    name: "RequestSignIn",
    category: "meta",
    readOnly: true,
    description: DESCRIPTION,
    parameters: {
        type: "object",
        properties: {
            target: { type: "string", description: "What to sign in to: gh, aws, gcloud, claude, codex, or another CLI by its command name" },
            machine: { type: "string", description: "A server's name, to sign in there. Leave out for the machine this session runs on" },
            command: { type: "string", description: "Only for a CLI Cavvy has no sign-in for: its own sign-in command, starting with the target, for the user to run" },
        },
        required: ["target"],
    },
    title: (i) => signInTitle(i as Record<string, unknown>),
    validate: (input) => inputError(input as Record<string, unknown>),
    async run(input, ctx) {
        const bad = inputError(input as Record<string, unknown>);
        if (bad) return { content: bad, isError: true };
        if (!ctx.ui.requestSignIn) return { content: NOBODY, isError: true };
        const r = await ctx.ui.requestSignIn(request(input, "RequestSignIn"), ctx.signal);
        return { content: r.text, isError: r.isError, display: { summary: r.summary } };
    },
};

function signInTitle(i: Record<string, unknown>): string {
    const s = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 40) : "");
    return `RequestSignIn(${s(i.target)}${s(i.machine) ? ` on ${s(i.machine)}` : ""})`;
}

/** The transcript's label for the served tool (by its MCP name), or undefined. */
export function signInToolTitle(name: string, input: Record<string, unknown>): string | undefined {
    return name === `mcp__${MCP_SERVER_NAME}__request_sign_in` ? signInTitle(input) : undefined;
}

export interface SignInToolHost {
    ask(req: SignInRequest, signal: AbortSignal): Promise<SignInAnswer>;
    /** Enforces rules that name the served tool, before the card. */
    authorize?(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ServerToolResult | undefined>;
    /** How long a call may wait: the CLI gives Cavvy's tools a limit, and a call that outlives it is lost. */
    waitMs: number;
}

const served = (text: string) => text.replaceAll("RequestSignIn", "request_sign_in").replaceAll("RequestSecret", "request_secret");

/** request_sign_in for Claude Code and Codex, through Cavvy's MCP server: the same card, the same answer. */
export function signInServerTools(h: SignInToolHost): ServerTool[] {
    return [
        {
            name: "request_sign_in",
            title: "Ask the user to sign in",
            description: served(DESCRIPTION),
            inputSchema: RequestSignInTool.parameters,
            annotations: { readOnlyHint: true, openWorldHint: false },
            async call(args, ctx) {
                const bad = inputError(args);
                if (bad) return { text: bad, isError: true };
                const denied = await h.authorize?.("request_sign_in", args, ctx.signal);
                if (denied) return denied;
                const r = await h.ask(request(args as Input, "request_sign_in", h.waitMs), ctx.signal);
                return { text: r.text, isError: r.isError };
            },
        },
    ];
}

export const SIGN_IN_INSTRUCTIONS = `# Sign-ins (${MCP_SERVER_NAME})

When something isn't signed in (gh, aws, gcloud, another CLI, on this machine or one of the user's servers), don't tell the user to run a login command and stop: call request_sign_in with the target (gh, aws, gcloud, claude, codex, …) and, for a server, its name as machine. Cavvy runs the sign-in and shows the user what to do; the call waits, then you carry on in the same turn. You get back whether it's signed in and as whom, never a code or a token. If they choose Later, or you're told it's still waiting, do what doesn't need it or end your turn: Cavvy tells you when they've signed in.`;

/**
 * A line for the end of a failed command's output, when the command ran a CLI that says it isn't signed in: tool
 * descriptions alone don't get an agent to ask. `tool`: the name the agent knows the tool by.
 */
export function signInHint(command: string, output: string, recipes: readonly SignInRecipe[], tool: "RequestSignIn" | "request_sign_in"): string | undefined {
    const r = signedOutIn(output, recipes, command);
    return r ? `${r.name} isn't signed in. Ask the user to sign in: call ${tool} with target "${r.id}", then run this again.` : undefined;
}
