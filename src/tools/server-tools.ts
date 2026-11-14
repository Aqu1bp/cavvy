// ServerKey, ServerAdd and ServerRemove: an agent sets up a server for the
// user, from any provider. The agent does what differs by provider (it runs
// the provider's own CLI: choosing a size, creating the machine). Cavvy does
// what an agent must never hold: the key it signs in with, the server's
// identity, and the user's yes before anything costs money or is deleted.
// Those run in Cavvy itself, so they work from a session that can't read
// ~/.ssh or the provider's credentials.

import type { ServerTool, ServerToolResult } from "../mcp/server";
import { SIGN_IN_RECIPES, signInRecipes } from "../agent/sign-in-recipes";
import type { Tool, ToolContext, ToolResult } from "./types";

/** A rented machine's details: as src/servers/store.ts keeps them. */
export interface ServerCloudInfo {
    provider: string;
    where?: string;
    cost?: string;
    teardown?: string[][];
}

/** The servers this machine knows, as an agent's tools may use them. The host's (the app, the terminal): missing on a server and in a one-shot run. */
export interface ServerSetup {
    get(name: string): Promise<{ destination: string; cloud?: ServerCloudInfo } | undefined>;
    names(): Promise<string[]>;
    /** Makes the key Cavvy signs in with and the server's own identity, and the start-up script that installs both. */
    makeKey(name: string): Promise<{ userDataFile: string }>;
    /** Whether a key was made just now for a server of that name (ServerKey, approved), which isn't added yet. */
    hasKey(name: string): Promise<boolean>;
    /**
     * Connects, puts Cavvy there and starts it. With a key made for it, it waits for the new machine to come up and
     * asks nothing; otherwise `trust` is asked about a host this machine hasn't seen. Throws what went wrong.
     */
    add(spec: { name: string; address: string; port?: number; cloud?: ServerCloudInfo }, o: { signal: AbortSignal; progress(text: string): void; trust(host: string, fingerprints: string[]): Promise<boolean> }): Promise<{ note?: string; lacks: string[] }>;
    /** The one-time copy of the user's settings, memory, skills and commands. What the server took, in words. */
    copy(name: string): Promise<string>;
    /** Runs its teardown commands, then forgets it. `signIn`: a command said its CLI is signed out. Throws what went wrong: the server then stays listed. */
    remove(name: string, o: { signal: AbortSignal; progress(text: string): void; signIn(target: string): Promise<boolean> }): Promise<void>;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LINE = /^[^\0-\x1f\x7f]{1,80}$/;
const ADDRESS = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+[\]-]{0,252}$/;
const WORD = /^[A-Za-z0-9_@%+=:,./-]{1,200}$/;

/** The CLIs a teardown command may be: the providers' own. One the user wrote a sign-in for (settings, with its status command) counts too. */
export const PROVIDER_CLIS = ["aws", "gcloud", "az", "doctl", "hcloud", "linode-cli", "vultr-cli", "scw", "oci", "fly", "flyctl", "upctl", "exo", "ibmcloud", "civo", "yc", "ovhcloud"];

/**
 * How long a sign-in asked for inside one of these calls waits before the call answers "still waiting" (its card
 * stays, and the agent hears when the user is done): an agent CLI gives a call about an hour, and the rest of the
 * call takes its share of that.
 */
const SIGN_IN_WAIT_MS = 20 * 60_000;

const fail = (content: string): ToolResult => ({ content, isError: true });
const line = (v: unknown) => typeof v === "string" && LINE.test(v.trim());

/** A word that has the CLI take what it does from somewhere else: the user is shown the command, and that's all it may be. */
const ELSEWHERE = /(?:^|=)@|file:\/\/|fileb:\/\/|^--?(?:cli-input-[a-z]+|flags-file)\b/i;

/**
 * Why Cavvy won't run `words` as a teardown command, or undefined. Checked when it's recorded and again when it's
 * run. Its program is a provider's CLI, or one the user wrote a sign-in for in their settings: never one of
 * Cavvy's built-in sign-ins (GitHub's CLI and the agent CLIs aren't what deletes a server).
 */
export function teardownCommandError(words: string[], mine: unknown): string | undefined {
    const text = words.join(" ");
    if (!words.length || words.length > 40 || !words.every((w) => WORD.test(w))) return `"${text.slice(0, 60)}" can't be a teardown command: plain words only, no quotes, pipes, variables or several commands.`;
    const built = new Set(SIGN_IN_RECIPES.map((r) => r.id));
    const own = signInRecipes(mine).filter((r) => !built.has(r.id) && r.status.run).map((r) => r.id);
    if (![...PROVIDER_CLIS, ...own].includes(words[0]!)) return `A teardown command starts with the provider's own CLI (${PROVIDER_CLIS.slice(0, 6).join(", ")}, …), not "${words[0]}".`;
    const bad = words.slice(1).find((w) => ELSEWHERE.test(w));
    if (bad) return `"${bad.slice(0, 40)}" can't be in a teardown command: name what's deleted in the command itself, not in a file or another place it's read from.`;
    return undefined;
}

function teardownError(list: unknown, ctx: { settings: ToolContext["settings"] }): string | undefined {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || !list.length || list.length > 8) return "teardown must list the provider CLI's commands that delete the server and what was made with it (1 to 8).";
    for (const c of list) {
        if (typeof c !== "string" || !c.trim()) return "Each teardown command is text.";
        const no = teardownCommandError(c.trim().split(/\s+/), ctx.settings.signIns);
        if (no) return no;
    }
    return undefined;
}

const words = (list: string[] | undefined) => list?.map((c) => c.trim().split(/\s+/));

function unavailable(ctx: ToolContext): string | undefined {
    if (!ctx.state.servers) return "Servers are set up from the user's own machine, in a session that stays open: not from a server, a sub-agent or a one-shot run.";
    if (ctx.mode() === "plan") return "Plan mode: nothing is created, added or removed. Put it in the plan.";
    return undefined;
}

// ---------------------------------------------------------------------------

type KeyInput = { name: string; provider: string; price: string; where?: string; size?: string; system?: string };

export const ServerKeyTool: Tool<KeyInput> = {
    name: "ServerKey",
    category: "meta",
    readOnly: true,
    description: `The first step in creating a server for the user at a cloud provider (AWS, Google Cloud, Azure, Hetzner, DigitalOcean, any other): asks the user to approve what you're about to create and what it costs, then makes the keys for it. Call it once you know exactly what you'll create, and before creating anything.

- The user sees the price and the details and chooses Create, Change… or Cancel, whatever the permission mode. Nothing that costs money may be created without this approval, and only what was approved.
- name is what the server will be called in Cavvy (lowercase letters, digits, dashes: "aws-mumbai"). provider, where, size and system are shown as you write them ("AWS Lightsail", "Mumbai", "2 CPUs · 2 GB · 60 GB", "Ubuntu 24.04"). price is the whole recurring cost with its period, from the provider's own price list ("$12/month"); look it up, don't guess.
- On Create you get the path of a start-up script. Pass that file as the new machine's user data when you create it. It gives the server the key Cavvy signs in with and the identity Cavvy expects, turns password logins off, and installs git, the GitHub CLI, Claude Code and Codex. So create no key pair for it and choose no password, and don't read or print the script (it holds the server's private host key).
- On Change… ask the user what they want, then call ServerKey again with the new details. On Cancel create nothing.
- Use the provider's own CLI for everything else. If it isn't signed in, ask with RequestSignIn first.
- Then call ServerAdd.`,
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "What the server will be called: lowercase letters, digits and dashes" },
            provider: { type: "string", description: 'Who it\'s rented from, and the product: "AWS Lightsail"' },
            price: { type: "string", description: 'The whole recurring cost and its period, from the provider\'s price list: "$12/month"' },
            where: { type: "string", description: 'The region, in plain words: "Mumbai"' },
            size: { type: "string", description: '"2 CPUs · 2 GB · 60 GB"' },
            system: { type: "string", description: '"Ubuntu 24.04"' },
        },
        required: ["name", "provider", "price"],
    },
    title: (i) => `ServerKey(${String(i.name ?? "").slice(0, 40)})`,
    validate(i) {
        if (typeof i.name !== "string" || !NAME.test(i.name)) return "name is lowercase letters, digits and dashes, up to 40 (like aws-mumbai).";
        if (!line(i.provider)) return "provider must say who the server is rented from, in one short line.";
        if (!line(i.price) || !/\d/.test(i.price)) return 'price must be the recurring cost with its period, like "$12/month".';
        for (const k of ["where", "size", "system"] as const) if (i[k] !== undefined && !line(i[k])) return `${k} must be one short line.`;
        return undefined;
    },
    async run(i, ctx) {
        const no = unavailable(ctx);
        if (no) return fail(no);
        const servers = ctx.state.servers!;
        if (await servers.get(i.name)) return fail(`There's already a server named ${i.name}. Pick another name.`);
        if (!ctx.ui.confirm) return fail("Creating a server needs the user's yes, and no one is here to give it (non-interactive session). Create nothing.");
        const facts: [string, string][] = [["Name", i.name], ["Where", [i.provider.trim(), i.where?.trim()].filter(Boolean).join(" · ")]];
        if (i.size) facts.push(["Size", i.size.trim()]);
        if (i.system) facts.push(["System", i.system.trim()]);
        const answer = await ctx.ui.confirm({ title: `Create a server for ${i.price.trim()}`, facts, yes: "Create", other: "Change…", no: "Cancel" }, ctx.signal);
        if (ctx.signal.aborted) return fail("Interrupted before the user answered. Create nothing.");
        if (answer === "other") return { content: "The user wants something different. Ask them what to change (the size, the place, the provider), then call ServerKey again with the new details. Create nothing yet.", display: { summary: "Change asked for" } };
        if (answer !== "yes") return { content: "The user cancelled. Create nothing, and don't ask again unless they bring it up.", display: { summary: "Cancelled" } };
        let made: { userDataFile: string };
        try {
            made = await servers.makeKey(i.name);
        } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
        }
        return {
            content: [
                `The user approved: ${i.name} at ${i.provider.trim()} for ${i.price.trim()}. Create exactly that now; anything else needs asking again.`,
                `Its start-up script is ${made.userDataFile}. Pass that file as the machine's user data (aws: --user-data file://${made.userDataFile}; gcloud: --metadata-from-file user-data=${made.userDataFile}; az: --custom-data ${made.userDataFile}; hcloud: --user-data-from-file ${made.userDataFile}; doctl: --user-data-file ${made.userDataFile}). Don't read or print it.`,
                "It installs Cavvy's key for the image's own login user (the one with uid 1000, like ubuntu, admin or ec2-user; root where there's none), so create no key pair and set no password. Leave SSH (port 22) reachable from the user's address.",
                `Once the machine has an address, call ServerAdd with name "${i.name}", address "<that user>@<its address>", its provider, where and cost, and teardown: the provider CLI's commands that delete everything you created for it.`,
            ].join("\n"),
            display: { summary: `Approved: ${i.price.trim()}` },
        };
    },
};

// ---------------------------------------------------------------------------

type AddInput = { name: string; address: string; port?: number; provider?: string; where?: string; cost?: string; teardown?: string[]; copy_settings?: boolean };

export const ServerAddTool: Tool<AddInput> = {
    name: "ServerAdd",
    category: "meta",
    readOnly: true,
    description: `Adds a server to Cavvy: connects over SSH with Cavvy's own connection, puts Cavvy there and starts it, so the user can run sessions on it. Use it instead of running ssh or \`cavvy servers add\` yourself: your shell may not reach the user's SSH keys, and Cavvy's can.

- For a server you just created after ServerKey: name as approved, address as "user@address", plus provider, where, cost (as approved) and teardown. It waits for the new machine to come up, and asks the user nothing.
- For a server the user already has: name and address ("user@host", or a Host from their SSH config). The user may be asked to trust its key.
- teardown is the provider CLI's commands that delete the server and everything created with it (a static address, a firewall, a disk), each as plain words ("aws lightsail delete-instance --instance-name aws-mumbai --region ap-south-1"). ServerRemove runs them later, after the user's yes. Give it for anything you created.
- Afterwards the user is offered the sign-ins the server lacks (Claude Code, Codex, GitHub) in one card. You're told what's signed in and what isn't.
- copy_settings: true copies the user's settings, memory, skills and commands there, once; only if they asked. Call it again on a server already added to do just that.`,
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "What the server is called: lowercase letters, digits and dashes" },
            address: { type: "string", description: 'user@host, or a Host from the user\'s SSH config' },
            port: { type: "number", description: "The SSH port, when it isn't 22" },
            provider: { type: "string", description: 'For a rented machine: who from ("AWS Lightsail")' },
            where: { type: "string", description: 'Its region, in plain words ("Mumbai")' },
            cost: { type: "string", description: 'What it costs, as the user approved it ("$12/month")' },
            teardown: { type: "array", items: { type: "string" }, description: "The provider CLI's commands that delete it and what was created with it, each as plain words" },
            copy_settings: { type: "boolean", description: "Also copy the user's settings, memory, skills and commands there (only if they asked)" },
        },
        required: ["name", "address"],
    },
    title: (i) => `ServerAdd(${String(i.name ?? "").slice(0, 40)})`,
    validate(i, ctx) {
        if (typeof i.name !== "string" || !NAME.test(i.name)) return "name is lowercase letters, digits and dashes, up to 40 (like build-box).";
        if (typeof i.address !== "string" || !ADDRESS.test(i.address)) return 'address must be "user@host", or a Host from the user\'s SSH config.';
        if (i.port !== undefined && (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535)) return "port must be a number from 1 to 65535.";
        for (const k of ["provider", "where", "cost"] as const) if (i[k] !== undefined && !line(i[k])) return `${k} must be one short line.`;
        if ((i.cost !== undefined || i.where !== undefined || i.teardown !== undefined) && !i.provider) return "Say the provider too, for a rented machine.";
        return teardownError(i.teardown, ctx);
    },
    async run(i, ctx) {
        const no = unavailable(ctx);
        if (no) return fail(no);
        const servers = ctx.state.servers!;
        const tool = ctx.signInTool ?? "RequestSignIn";
        if (await servers.get(i.name)) {
            if (!i.copy_settings) return fail(`${i.name} is already one of the user's servers.`);
            try {
                const took = await servers.copy(i.name);
                return { content: took ? `Copied to ${i.name}: ${took}.` : `${i.name} already had everything a copy would bring.`, display: { summary: "Copied" } };
            } catch (e) {
                return fail(`The copy to ${i.name} didn't go through: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        const made = await servers.hasKey(i.name);
        if (made && !i.address.includes("@")) return fail('For the server you created, address must be "user@address": the image\'s login user (ubuntu, admin, ec2-user, root) and the machine\'s address.');
        // A server of the user's own, in a mode that asks: adding it connects with their keys and installs Cavvy there.
        if (!made && ctx.mode() !== "bypassPermissions") {
            if (!ctx.ui.confirm) return fail("Adding a server needs the user's yes here, and no one is here to give it (non-interactive session).");
            const answer = await ctx.ui.confirm({ title: `Add ${i.name} as a server`, facts: [["Address", i.address]], yes: "Add", no: "Cancel" }, ctx.signal);
            if (answer !== "yes") return { content: "The user said no. Don't add it, and don't ask again unless they bring it up.", display: { summary: "Cancelled" } };
        }
        const cloud = i.provider ? { provider: i.provider.trim(), ...(i.where ? { where: i.where.trim() } : {}), ...(i.cost ? { cost: i.cost.trim() } : {}), ...(i.teardown ? { teardown: words(i.teardown)! } : {}) } : undefined;
        let added: { note?: string; lacks: string[] };
        try {
            added = await servers.add(
                { name: i.name, address: i.address, port: i.port, cloud },
                {
                    signal: ctx.signal,
                    progress: (text) => ctx.onProgress?.(`${text}\n`),
                    trust: async (host, fingerprints) => {
                        if (!ctx.ui.confirm) return false;
                        return (await ctx.ui.confirm({ title: `Trust ${host}`, facts: fingerprints.map((f) => ["Key", f] as [string, string]), yes: "Trust", no: "Cancel" }, ctx.signal)) === "yes";
                    },
                },
            );
        } catch (e) {
            // Said either way: an interrupted agent that never mentions it leaves the user paying for a machine they can't see.
            if (ctx.signal.aborted) return fail(`Interrupted while adding ${i.name}. It wasn't added.${made ? "\nThe machine you created is still there and still costs money: tell the user, and call ServerAdd again to finish or delete it with the provider's CLI." : ""}`);
            return fail(`${i.name} wasn't added: ${e instanceof Error ? e.message : String(e)}${made ? "\nThe machine you created is still there and still costs money: fix what's wrong and call ServerAdd again, or delete it with the provider's CLI and tell the user." : ""}`);
        }
        const out = [`${i.name} is one of the user's servers now${cloud?.cost ? ` (${cloud.cost})` : ""}. Sessions there run without asking (Bypass).${added.note ? ` ${added.note}` : ""}`];
        if (added.lacks.length) out.push(`It lacks: ${added.lacks.join("; ")}.`);
        if (i.copy_settings) {
            try {
                const took = await servers.copy(i.name);
                if (took) out.push(`Copied there: ${took}.`);
            } catch (e) {
                out.push(`The copy of the user's settings didn't go through: ${e instanceof Error ? e.message : String(e)}`);
            }
        } else out.push("The user's settings, memory, skills and commands weren't copied there. Offer it; ServerAdd with copy_settings: true on this name does it.");
        // Its sign-ins, in one card: each is the user's to do, and none is needed for the server to be listed.
        if (ctx.ui.requestSignIn && !ctx.signal.aborted) {
            const r = await ctx.ui.requestSignIn({ targets: [{ target: "claude" }, { target: "codex" }, { target: "gh" }], machine: i.name, tool, waitMs: SIGN_IN_WAIT_MS }, ctx.signal);
            out.push(r.text);
        }
        return { content: out.join("\n"), display: { summary: `Added ${i.name}` } };
    },
};

// ---------------------------------------------------------------------------

export const ServerRemoveTool: Tool<{ name: string }> = {
    name: "ServerRemove",
    category: "meta",
    readOnly: true,
    description: `Removes one of the user's servers from Cavvy. For a server an agent created, it also deletes the machine at its provider: Cavvy runs the teardown commands recorded when it was added, after the user's yes (asked in every permission mode). Use it when the user asks to delete, tear down or remove a server; don't delete a server's cloud resources yourself.

- The user sees what will be deleted and the commands that will run, and chooses Delete or Cancel.
- If the provider's CLI is signed out, the user is asked to sign in, and it goes on.
- If a command fails, the server stays listed and you're told what the CLI said.
- Afterwards, check with the provider's CLI that nothing was left behind (a static address, a disk, a firewall rule), and say what you found.
- A server that wasn't created by an agent is only forgotten here: nothing on it is touched.`,
    parameters: {
        type: "object",
        properties: { name: { type: "string", description: "The server's name" } },
        required: ["name"],
    },
    title: (i) => `ServerRemove(${String(i.name ?? "").slice(0, 40)})`,
    validate: (i) => (typeof i.name !== "string" || !NAME.test(i.name) ? "name is the server's name as Cavvy lists it." : undefined),
    async run(i, ctx) {
        const no = unavailable(ctx);
        if (no) return fail(no);
        const servers = ctx.state.servers!;
        const s = await servers.get(i.name);
        if (!s) {
            const names = await servers.names();
            return fail(`No server is called ${i.name}.${names.length ? ` The user's servers: ${names.join(", ")}.` : " The user has added none."}`);
        }
        const teardown = s.cloud?.teardown ?? [];
        if (teardown.length || ctx.mode() !== "bypassPermissions") {
            if (!ctx.ui.confirm) return fail("Removing a server needs the user's yes, and no one is here to give it (non-interactive session).");
            const facts: [string, string][] = s.cloud ? [["Where", [s.cloud.provider, s.cloud.where].filter(Boolean).join(" · ")], ...(s.cloud.cost ? [["Cost", s.cloud.cost] as [string, string]] : [])] : [["Address", s.destination]];
            const answer = await ctx.ui.confirm(
                teardown.length ? { title: `Delete ${i.name}`, facts, commands: teardown.map((c) => c.join(" ")), yes: "Delete", no: "Cancel", danger: true } : { title: `Remove ${i.name} from Cavvy`, facts, yes: "Remove", no: "Cancel" },
                ctx.signal,
            );
            if (answer !== "yes") return { content: `The user said no. ${i.name} is untouched. Don't ask again unless they bring it up.`, display: { summary: "Cancelled" } };
        }
        try {
            await servers.remove(i.name, {
                signal: ctx.signal,
                progress: (text) => ctx.onProgress?.(`${text}\n`),
                signIn: async (target) => Boolean(ctx.ui.requestSignIn && (await ctx.ui.requestSignIn({ targets: [{ target }], tool: ctx.signInTool ?? "RequestSignIn", waitMs: SIGN_IN_WAIT_MS }, ctx.signal)).signedIn),
            });
        } catch (e) {
            return fail(`${i.name} wasn't removed: ${e instanceof Error ? e.message : String(e)}\nIt's still listed${teardown.length ? ", and whatever of it still exists still costs money. Say so" : ""}.`);
        }
        if (!teardown.length) return { content: `${i.name} is forgotten here. Nothing on the server was touched: Cavvy and its sessions are still there.${s.cloud ? " It's a rented machine with no teardown recorded: it still exists and still costs money. Say so, and delete it with the provider's CLI if the user wants." : ""}`, display: { summary: `Removed ${i.name}` } };
        return { content: `${i.name} is deleted: its teardown ran (${teardown.map((c) => c.join(" ")).join("; ")}) and it's gone from Cavvy. Check with the provider's CLI that nothing was left behind, and tell the user what you found.`, display: { summary: `Deleted ${i.name}` } };
    },
};

export const SERVER_TOOLS: Tool<any>[] = [ServerKeyTool, ServerAddTool, ServerRemoveTool];
export const SERVER_TOOL_NAMES = SERVER_TOOLS.map((t) => t.name);

const SERVED: Record<string, Tool<any>> = { server_key: ServerKeyTool, server_add: ServerAddTool, server_remove: ServerRemoveTool };

/** The served name of a server tool (server_add), by its own (ServerAdd). */
export function servedServerName(tool: string): string | undefined {
    return Object.keys(SERVED).find((n) => SERVED[n]!.name === tool);
}

/** A call of a served server tool (mcp__cavvy__server_add) as the Cavvy tool it is, for the transcript. */
export function nativeServerCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    const native = SERVED[tool];
    return native ? { name: native.name, input } : undefined;
}

const served = (text: string) =>
    text.replaceAll("ServerKey", "server_key").replaceAll("ServerAdd", "server_add").replaceAll("ServerRemove", "server_remove").replaceAll("RequestSignIn", "request_sign_in");

/** The server tools for Claude Code and Codex, through Cavvy's MCP server. `run` takes a call through Cavvy's checks, as the same tool called by a model Cavvy runs. */
export function serverServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>): ServerTool[] {
    return Object.entries(SERVED).map(([name, tool]) => ({
        name,
        title: { server_key: "Approve and prepare a new server", server_add: "Add a server", server_remove: "Remove a server" }[name],
        description: served(tool.description),
        inputSchema: tool.parameters,
        annotations: { readOnlyHint: false, destructiveHint: name === "server_remove", openWorldHint: true },
        call: async (args, { signal, meta }) => {
            const r = await run(tool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined);
            return { ...r, text: served(r.text) };
        },
    }));
}

export const SERVER_INSTRUCTIONS = `# Servers (cavvy)

The user can ask you to set up a server for them at any cloud provider, or to add one they have, or to delete one. Cavvy does the parts you mustn't: the SSH key, the server's identity, and the user's yes before money is spent or anything is deleted.

To create one: sign the provider's CLI in if needed (request_sign_in), find what fits and its price with that CLI, call server_key with exactly what you'll create (the user approves the price there), create the machine with the start-up script server_key gives you as its user data, then call server_add with its address, cost and teardown commands. Don't make key pairs, don't run ssh, and don't create anything before server_key says the user approved.

To add a server the user already has, call server_add with its name and address: Cavvy's own connection reaches their SSH keys, yours may not. To delete or remove one, call server_remove: for a server an agent created it deletes the machine too, after the user's yes.`;
