// An agent sets a server up for the user: ServerKey (the user's yes to the price, and Cavvy's keys), ServerAdd
// (no key file, no trust question, the server's sign-ins) and ServerRemove (the machine deleted too, after
// another yes). Run for real against the pretend server (test/helpers/fake-ssh.ts) and pretend provider CLIs:
// the keys and the start-up script, the tools on their own, and the whole thing from a window.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

const iso = isolate();
const fake = fakeSsh();
const A = "aaaaaaaaaaaa-1";

// Pretend CLIs. On the pretend server: gh (signed out until its page is "finished"), Claude Code (signed in) and
// Codex (signed out). On this machine: the provider's own, which deletes the machine and is signed out at first.
const there = join(dirname(fake.bin), "bin");
const shim = (dir: string, name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
};
shim(there, "gh", `case "$1 $2" in
"auth status") [ -e "$HOME/gh-in" ] && { echo "✓ Logged in to github.com account octo (keyring)"; exit 0; }; echo "You are not logged into any GitHub hosts. To log in, run: gh auth login"; exit 1 ;;
"auth login") echo "! First copy your one-time code: ABCD-1234"; echo "Open this URL to continue in your web browser: https://github.com/login/device"; i=0; while [ ! -e "$HOME/gh-approve" ]; do sleep 0.05; i=$((i+1)); [ $i -gt 400 ] && exit 1; done; touch "$HOME/gh-in"; exit 0 ;;
esac
exit 0`);
shim(there, "claude", `[ "$1 $2" = "auth status" ] && echo '{ "loggedIn": true, "email": "me@example.com" }'; exit 0`);
shim(there, "codex", `[ "$1 $2" = "login status" ] && echo "Not logged in"; exit 0`);
const mine = tempDir("cavvy-agent-setup-bin-");
const cloud = join(mine, "cloud");
mkdirSync(cloud);
shim(mine, "aws", `d=${JSON.stringify(cloud)}
echo "$*" >> "$d/calls"
case "$1 $2" in
"sts get-caller-identity") [ -e "$d/in" ] && { echo 123456789012; exit 0; }; echo "aws: [ERROR]: Unable to locate credentials. You can configure credentials by running \\"aws login\\"."; exit 253 ;;
"login ") echo "Attempting to open your default browser."; echo "https://us-east-1.signin.aws.amazon.com/v1/authorize?x=1"; i=0; while [ ! -e "$d/approve" ]; do sleep 0.05; i=$((i+1)); [ $i -gt 400 ] && exit 1; done; touch "$d/in"; exit 0 ;;
"lightsail delete-instance") [ -e "$d/in" ] || { echo "aws: [ERROR]: Unable to locate credentials."; exit 253; }; [ -e "$d/refuse" ] && { echo "An error occurred (AccessDeniedException): not allowed"; exit 254; }; echo deleted >> "$d/deleted"; exit 0 ;;
esac
exit 0`);
process.env.PATH = `${mine}:${process.env.PATH}`;

const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { expectHostKey, forgetScript, forgetServerKey, freshKey, knownHostLines, madeKey, makeServerKey, serverKeysDir, setKnownHostLines, startupScript } = await import("../src/servers/keys");
const { setupTiming } = await import("../src/servers/agent-setup");
const { ownKnownHosts } = await import("../src/servers/ssh");
const { checkedCloud, getServer, listServers } = await import("../src/servers/store");
const { ServerAddTool, ServerKeyTool, ServerRemoveTool, serverServerTools } = await import("../src/tools/server-tools");
const { PermissionChecker } = await import("../src/permissions/checker");
const { sandboxPolicy } = await import("../src/permissions/sandbox");
const { BashTool } = await import("../src/tools/bash");
const { ReadTool } = await import("../src/tools/file-tools");
const { GrepTool } = await import("../src/tools/search-tools");
import type { BuildSource } from "../src/servers/build";
import type { ConfirmInteraction, ServerEvent, SessionSnapshot, SessionState, SignInInteraction, Turn } from "../src/server/protocol";
import type { ServerSetup } from "../src/tools/server-tools";
import type { ConfirmRequest, ToolContext } from "../src/tools/types";

// A new machine is looked at often, and what it installs isn't waited for long: nothing installs on the pretend one.
Object.assign(setupTiming, { readyMs: 15_000, settledMs: 300, everyMs: 100 });

const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { allowBypass: true } }));
const source: BuildSource = { id: A, gui: true, build: async () => fake.bundle(A, { gui: true }), compare: (theirs: string) => (theirs === A ? "same" : "older") } as BuildSource;
const srv = await startServer({ token: "mine", serverBuilds: source, log: () => undefined });

afterEach(() => fake.fail());
afterAll(async () => {
    await srv.stop().catch(() => undefined);
    mock.stop();
    fake.cleanup();
    iso.cleanup();
});

describe("the keys Cavvy makes for a new server", () => {
    test("a sign-in key only Cavvy reads, the server's own identity, and a start-up script that installs both", async () => {
        const made = await makeServerKey("keys-one");
        expect(made.identityFile).toBe(join(serverKeysDir(), "keys-one"));
        expect(statSync(made.identityFile).mode & 0o777).toBe(0o600);
        expect(statSync(serverKeysDir()).mode & 0o777).toBe(0o700);
        expect(made.publicKey).toMatch(/^ssh-ed25519 \S+ cavvy-keys-one$/);
        expect(made.hostPublicKey).toMatch(/^ssh-ed25519 \S+ cavvy-keys-one-host$/);
        const script = readFileSync(made.userDataFile, "utf-8");
        expect(statSync(made.userDataFile).mode & 0o777).toBe(0o600);
        expect(script.startsWith("#!/bin/sh\n")).toBe(true);
        expect(script).toContain(made.publicKey);
        expect(script).toContain(made.hostPublicKey);
        // The server's private host key is in it (that's how the server gets it), and nowhere else here; Cavvy's own private key never is.
        expect(script).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
        // (Its first lines are the same in every key of this kind: the ones after hold the key.)
        for (const line of readFileSync(made.identityFile, "utf-8").split("\n").slice(2, 5)) expect(script).not.toContain(line);
        expect(existsSync(join(serverKeysDir(), "keys-one.host"))).toBe(false);
        expect(script).toContain("PasswordAuthentication no");
        // Asked again for the same name: new keys, and the old script is gone.
        const again = await makeServerKey("keys-one");
        expect(again.publicKey).not.toBe(made.publicKey);
        expect(existsSync(made.userDataFile)).toBe(false);
        await expect(makeServerKey("Not A Name")).rejects.toThrow("lowercase");
    });

    test("the identity made for it is the only one its address may show; forgetting it leaves nothing", async () => {
        const made = await makeServerKey("keys-two");
        writeFileSync(ownKnownHosts(), "203.0.113.9 ssh-ed25519 AAAAoldmachine\nother.example ssh-ed25519 AAAAother\n");
        expect(expectHostKey("keys-two", "203.0.113.9")).toBe(ownKnownHosts());
        const [type, data] = made.hostPublicKey.split(" ");
        // An address handed on from a machine that's gone doesn't keep that machine's key.
        expect(readFileSync(ownKnownHosts(), "utf-8")).toBe(`other.example ssh-ed25519 AAAAother\n203.0.113.9 ${type} ${data}\n`);
        expectHostKey("keys-two", "203.0.113.9", 2222);
        expect(readFileSync(ownKnownHosts(), "utf-8")).toContain(`[203.0.113.9]:2222 ${type} ${data}`);
        expect(madeKey("keys-two")).toMatchObject({ identityFile: made.identityFile });
        forgetServerKey("keys-two", "203.0.113.9");
        expect(madeKey("keys-two")).toBeUndefined();
        expect(existsSync(made.identityFile)).toBe(false);
        expect(existsSync(made.userDataFile)).toBe(false);
        expect(readFileSync(ownKnownHosts(), "utf-8")).not.toMatch(/^203\.0\.113\.9 /m);
        expect(() => expectHostKey("never-made", "x.example")).toThrow("No key was made");
    });

    test("a key counts as a machine being created only while its start-up script is still to do its part, and lately", async () => {
        expect(freshKey("keys-three")).toBe(false);
        await makeServerKey("keys-three");
        expect(freshKey("keys-three")).toBe(true);
        // Approved long ago, and no machine came of it: adding that name now is adding a server like any other.
        const long = new Date(Date.now() - 7 * 3_600_000);
        utimesSync(join(serverKeysDir(), "keys-three.script"), long, long);
        expect(freshKey("keys-three")).toBe(false);
        // Added (the script is done with): the key stays for the server, as no sign of a new machine.
        await makeServerKey("keys-three");
        forgetScript("keys-three");
        expect(madeKey("keys-three")).toBeDefined();
        expect(freshKey("keys-three")).toBe(false);
        forgetServerKey("keys-three");
    });

    test("what Cavvy's list held for an address can be put back", () => {
        writeFileSync(ownKnownHosts(), "a.example ssh-ed25519 AAAAa\n[b.example]:2222 ssh-ed25519 AAAAb\n");
        expect(knownHostLines("a.example")).toEqual(["a.example ssh-ed25519 AAAAa"]);
        expect(knownHostLines("b.example", 2222)).toEqual(["[b.example]:2222 ssh-ed25519 AAAAb"]);
        expect(knownHostLines("b.example")).toEqual([]);
        setKnownHostLines("a.example", undefined, []);
        expect(readFileSync(ownKnownHosts(), "utf-8")).toBe("[b.example]:2222 ssh-ed25519 AAAAb\n");
        setKnownHostLines("a.example", undefined, ["a.example ssh-ed25519 AAAAa"]);
        expect(readFileSync(ownKnownHosts(), "utf-8")).toBe("[b.example]:2222 ssh-ed25519 AAAAb\na.example ssh-ed25519 AAAAa\n");
    });

    test("agents are kept from the key as from Cavvy's other credentials: file tools refused in every mode, a command that names it asked about", () => {
        const cwd = tempDir("cavvy-agent-setup-fence-");
        const checker = new PermissionChecker(() => ({}) as any, cwd);
        const key = join(serverKeysDir(), "aws-mumbai");
        for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions"] as const) {
            expect(checker.check(ReadTool, { file_path: key }, mode, cwd)).toMatchObject({ behavior: "deny", reason: "Access to Cavvy credential store is blocked." });
            expect(checker.check(GrepTool, { pattern: "PRIVATE", path: serverKeysDir() }, mode, cwd).behavior).toBe("deny");
        }
        for (const mode of ["default", "acceptEdits"] as const) expect(checker.check(BashTool, { command: `cat ${key}` }, mode, cwd)).toMatchObject({ behavior: "ask", reason: expect.stringContaining("Cavvy credential store") });
        // Auto mode's sandbox can't read or list the folder.
        const policy = sandboxPolicy([cwd], { cavvyHome: iso.home });
        expect(policy.unreadable.some((p: string) => p.endsWith("/server-keys"))).toBe(true);
    });

    test("the script signs in the image's own user, and installs what agents use after the sign-in works", () => {
        const s = startupScript("ssh-ed25519 PUB cavvy-x", "-----BEGIN OPENSSH PRIVATE KEY-----\nHOSTPRIV\n-----END OPENSSH PRIVATE KEY-----\n", "ssh-ed25519 HOSTPUB cavvy-x-host");
        expect(s.indexOf("authorized_keys")).toBeLessThan(s.indexOf("apt-get"));
        expect(s.indexOf("systemctl restart ssh")).toBeLessThan(s.indexOf("apt-get"));
        expect(s).toContain("$3 == 1000");
        expect(s).toContain("touch /var/lib/cavvy-setup-done");
    });

    test("a rented machine's details: one short line each, and teardown commands that are words", () => {
        expect(checkedCloud({ provider: " AWS Lightsail ", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "x"]] })).toEqual({ provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "x"]] });
        expect(() => checkedCloud({ provider: "a\nb" })).toThrow("one short line");
        expect(() => checkedCloud({ provider: "AWS", teardown: [["sh", "-c", "rm -rf ~"]] })).toThrow("plain words");
        expect(() => checkedCloud({ provider: "AWS", teardown: [["/tmp/evil", "x"]] })).toThrow("plain words");
        expect(() => checkedCloud({ provider: "AWS", teardown: [["aws", "$(id)"]] })).toThrow("plain words");
    });
});

describe("the tools, by themselves", () => {
    const servers = (over: Partial<ServerSetup> = {}): ServerSetup => ({
        get: async () => undefined,
        names: async () => [],
        hasKey: async () => false,
        makeKey: async () => ({ userDataFile: "/tmp/cavvy-x/user-data.sh" }),
        add: async () => ({ lacks: [] }),
        copy: async () => "3 skills",
        remove: async () => undefined,
        ...over,
    });
    const ctx = (o: { servers?: ServerSetup | null; confirm?: (req: ConfirmRequest) => "yes" | "other" | "no"; mode?: string; signIns?: unknown[]; signal?: AbortSignal } = {}) => {
        const asked: ConfirmRequest[] = [];
        const c = {
            state: { servers: o.servers === null ? undefined : (o.servers ?? servers()) },
            settings: { signIns: o.signIns },
            signal: o.signal ?? new AbortController().signal,
            mode: () => o.mode ?? "bypassPermissions",
            ui: { confirm: o.confirm ? async (req: ConfirmRequest) => (asked.push(req), o.confirm!(req)) : undefined },
        } as unknown as ToolContext;
        return { c, asked };
    };
    const key = { name: "aws-mumbai", provider: "AWS Lightsail", where: "Mumbai", size: "2 CPUs · 2 GB · 60 GB", system: "Ubuntu 24.04", price: "$12/month" };

    test("ServerKey asks with the price in the question, in Bypass too, and makes keys only on Create", async () => {
        let made = 0;
        const s = servers({ makeKey: async () => (made++, { userDataFile: "/tmp/cavvy-x/user-data.sh" }) });
        const yes = ctx({ servers: s, confirm: () => "yes", mode: "bypassPermissions" });
        const r = await ServerKeyTool.run(key, yes.c);
        expect(yes.asked).toEqual([{ title: "Create a server for $12/month", facts: [["Name", "aws-mumbai"], ["Where", "AWS Lightsail · Mumbai"], ["Size", "2 CPUs · 2 GB · 60 GB"], ["System", "Ubuntu 24.04"]], yes: "Create", other: "Change…", no: "Cancel" }]);
        expect(r.content).toContain("The user approved: aws-mumbai at AWS Lightsail for $12/month.");
        expect(r.content).toContain("--user-data file:///tmp/cavvy-x/user-data.sh");
        expect(made).toBe(1);

        const change = await ServerKeyTool.run(key, ctx({ servers: s, confirm: () => "other" }).c);
        expect(change.content).toContain("Ask them what to change");
        const no = await ServerKeyTool.run(key, ctx({ servers: s, confirm: () => "no" }).c);
        expect(no.content).toBe("The user cancelled. Create nothing, and don't ask again unless they bring it up.");
        // Neither made a key: nothing to create a machine with.
        expect(made).toBe(1);
    });

    test("ServerKey: no one to ask, no keys; nor in plan mode, on a server, or for a name that's taken", async () => {
        let made = 0;
        const s = servers({ makeKey: async () => (made++, { userDataFile: "x" }), get: async (n) => (n === "taken" ? { destination: "a@b" } : undefined) });
        expect((await ServerKeyTool.run(key, ctx({ servers: s }).c)).content).toContain("no one is here to give it");
        expect((await ServerKeyTool.run(key, ctx({ servers: s, confirm: () => "yes", mode: "plan" }).c)).content).toContain("Plan mode");
        expect((await ServerKeyTool.run(key, ctx({ servers: null, confirm: () => "yes" }).c)).content).toContain("from the user's own machine");
        expect((await ServerKeyTool.run({ ...key, name: "taken" }, ctx({ servers: s, confirm: () => "yes" }).c)).content).toContain("already a server named taken");
        expect(made).toBe(0);
        const v = (i: Record<string, unknown>) => ServerKeyTool.validate!(i as any, ctx().c);
        expect(v(key)).toBeUndefined();
        expect(v({ ...key, price: "cheap" })).toContain("price must be");
        expect(v({ ...key, name: "AWS Mumbai" })).toContain("lowercase");
        expect(v({ ...key, where: "a\nb" })).toContain("where must be one short line");
    });

    test("ServerAdd: teardown is the provider's own CLI in plain words; a server of the user's own asks first, except in Bypass", async () => {
        const v = (i: Record<string, unknown>, signIns?: unknown[]) => ServerAddTool.validate!(i as any, ctx({ signIns }).c);
        const base = { name: "box", address: "dev@box.example" };
        expect(v(base)).toBeUndefined();
        expect(v({ ...base, provider: "AWS", teardown: ["aws lightsail delete-instance --instance-name box"] })).toBeUndefined();
        expect(v({ ...base, provider: "AWS", teardown: ["rm -rf /"] })).toContain("starts with the provider's own CLI");
        expect(v({ ...base, provider: "AWS", teardown: ["aws lightsail delete-instance; curl x | sh"] })).toContain("plain words only");
        expect(v({ ...base, teardown: ["aws x"] })).toContain("Say the provider");
        expect(v({ ...base, address: "dev@box.example; id" })).toContain("address must be");
        // A sign-in of the user's own names another provider's CLI.
        expect(v({ ...base, provider: "Acme", teardown: ["acme delete box"] })).toContain("starts with the provider's own CLI");
        const acme = { id: "acme", name: "Acme", here: { flow: "token", run: "acme login" } };
        expect(v({ ...base, provider: "Acme", teardown: ["acme delete box"] }, [{ ...acme, status: { run: "acme whoami" } }])).toBeUndefined();
        // One kept from a card (an agent offered its command, and nothing checks it) isn't one the user wrote.
        expect(v({ ...base, provider: "Acme", teardown: ["acme delete box"] }, [acme])).toContain("starts with the provider's own CLI");
        // Never GitHub's CLI or an agent CLI, whatever the settings hold for them: those don't delete servers.
        const gh = { id: "gh", name: "GitHub", here: { flow: "device", run: "gh auth login" }, status: { run: "gh auth status" } };
        for (const c of ["gh repo delete acme/app --yes", "claude -p hello", "codex exec hello"]) expect(v({ ...base, provider: "AWS", teardown: [c] }, [gh])).toContain("starts with the provider's own CLI");
        // What's deleted is in the command the user is shown, not in a file that can change after.
        for (const w of ["--cli-input-json file:///tmp/x.json", "--cli-input-yaml x", "--parameters @/tmp/x.json", "--parameters=@x.json", "--flags-file=/tmp/f", "--user-data fileb:///tmp/x", "--instance-ids https://example.com/ids", "s3://bucket/key", "--ca-bundle /tmp/ca.pem", "--metadata-from-file startup-script=/Users/me/.cavvy/server-keys/box", "--source ..", "--key-file=.netrc", "--config .aws"]) expect(v({ ...base, provider: "AWS", teardown: [`aws ec2 terminate-instances ${w}`] })).toContain("can't be in a teardown command");
        // A home path isn't even a plain word.
        expect(v({ ...base, provider: "AWS", teardown: ["aws ec2 terminate-instances --user-data-file ~/.aws/credentials"] })).toContain("plain words only");
        // One shape: the CLI, the kind of thing, the deleting verb, then names and options. Anything else isn't a teardown,
        // whatever it calls what it works on.
        const not = "can't be a teardown command. Each one is the CLI, what kind of thing it deletes";
        for (const c of [
            "aws configure set region us-east-1", "aws configure set default.x delete", "aws ec2 describe-instances", "aws ec2 run-instances --image-id ami-1", "aws ec2 create-tags delete", "aws lightsail --region us-east-1 delete-instance", "aws s3 cp bucket x", "aws ec2 wait instance-running",
            "az extension add --name x --yes", "az extension remove --name x", "gcloud components install alpha --quiet", "gcloud config set project delete", "gcloud auth login", "gcloud compute ssh box delete",
            "gcloud compute instances create delete --zone us-central1-a", "doctl compute droplet create delete --size s-1vcpu-1gb", "gcloud run deploy delete", "gcloud builds submit delete", "fly deploy delete", "doctl serverless deploy delete",
            "linode-cli register-plugin delete", "ibmcloud cf install-plugin delete -f", "gcloud projects add-iam-policy-binding delete --member user:x --role owner", "hcloud context delete default", "gcloud projects delete p", "ibmcloud plugin-delete x",
        ]) expect(v({ ...base, provider: "X", teardown: [c] })).toContain(not);
        for (const c of [
            "aws lightsail delete-instance --instance-name box", "aws lightsail release-static-ip --static-ip-name box-ip", "aws ec2 terminate-instances --instance-ids i-0123", "aws ec2 wait instance-terminated --instance-ids i-0123", "aws ec2 delete-security-group --group-id sg-1", "aws ec2 release-address --allocation-id eipalloc-1",
            "gcloud compute instances delete box --zone us-central1-a --quiet", "gcloud compute firewall-rules delete allow-ssh --quiet", "gcloud compute addresses delete box-ip --region us-central1 --quiet",
            "az vm delete --resource-group rg --name box --yes", "az group delete --name rg --yes", "az network public-ip delete --resource-group rg --name box-ip",
            "hcloud server delete box", "hcloud ssh-key delete cavvy-box", "hcloud primary-ip delete box-ip", "doctl compute droplet delete box --force", "doctl compute ssh-key delete 123 --force",
            "fly apps destroy box --yes", "fly machine destroy 123 --force", "flyctl ips release 203.0.113.9", "linode-cli linodes delete 123", "vultr-cli instance delete 123", "scw instance server terminate 123 with-ip=true",
            "oci compute instance terminate --instance-id ocid1.instance.oc1 --force", "exo compute instance delete box --force", "civo instance remove box --yes", "yc compute instance delete box", "upctl server delete 123", "ibmcloud is instance-delete 123 --force", "ibmcloud is floating-ip-release 123 --force",
        ]) expect(v({ ...base, provider: "X", teardown: [c] })).toBeUndefined();

        const added: unknown[] = [];
        const s = servers({ add: async (spec) => (added.push(spec), { lacks: ["git"] }) });
        const manual = ctx({ servers: s, confirm: () => "no", mode: "default" });
        expect((await ServerAddTool.run(base, manual.c)).content).toContain("The user said no");
        expect(manual.asked).toEqual([{ title: "Add box as a server", facts: [["Address", "dev@box.example"]], yes: "Add", no: "Cancel" }]);
        expect(added).toEqual([]);
        const bypass = ctx({ servers: s, confirm: () => "no", mode: "bypassPermissions" });
        const r = await ServerAddTool.run(base, bypass.c);
        expect(bypass.asked).toEqual([]);
        expect(r.content).toContain("box is one of the user's servers now.");
        expect(r.content).toContain("It lacks: git.");
        expect(added).toEqual([{ name: "box", address: "dev@box.example", port: undefined, cloud: undefined }]);
    });

    test("ServerAdd for a machine just created asks nothing, records what it costs and how it's deleted, and needs a login user", async () => {
        const added: any[] = [];
        const s = servers({ hasKey: async () => true, add: async (spec) => (added.push(spec), { lacks: [] }) });
        const c = ctx({ servers: s, confirm: () => "no", mode: "default" });
        expect((await ServerAddTool.run({ name: "aws-mumbai", address: "203.0.113.7" }, c.c)).content).toContain('address must be "user@address"');
        const r = await ServerAddTool.run({ name: "aws-mumbai", address: "ubuntu@203.0.113.7", provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: ["aws lightsail delete-instance --instance-name aws-mumbai"] }, c.c);
        expect(c.asked).toEqual([]);
        expect(added[0].cloud).toEqual({ provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "aws-mumbai"]] });
        expect(r.content).toContain("aws-mumbai is one of the user's servers now ($12/month).");
        // A failure after the machine exists says it still costs money.
        const failing = servers({ hasKey: async () => true, add: async () => { throw new Error("it didn't let Cavvy in"); } });
        expect((await ServerAddTool.run({ name: "aws-mumbai", address: "ubuntu@203.0.113.7" }, ctx({ servers: failing }).c)).content).toContain("still costs money");
        // So does an interruption: the agent that stops there still has to say so.
        const stopped = new AbortController();
        stopped.abort();
        const cut = await ServerAddTool.run({ name: "aws-mumbai", address: "ubuntu@203.0.113.7" }, ctx({ servers: failing, signal: stopped.signal }).c);
        expect(cut.content).toContain("Interrupted while adding aws-mumbai. It wasn't added.");
        expect(cut.content).toContain("still costs money: tell the user");
        // One of the user's own that was interrupted costs nothing new.
        const theirs = servers({ add: async () => { throw new Error("Stopped."); } });
        expect((await ServerAddTool.run({ name: "box", address: "dev@box.example" }, ctx({ servers: theirs, signal: stopped.signal }).c)).content).toBe("Interrupted while adding box. It wasn't added.");
    });

    test("ServerRemove shows what will be deleted and the commands, and does nothing on Cancel", async () => {
        const removed: string[] = [];
        const rented = { destination: "ubuntu@203.0.113.7", cloud: { provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "aws-mumbai"]] } };
        const s = servers({ get: async (n) => (n === "aws-mumbai" ? rented : n === "box" ? { destination: "dev@box.example" } : undefined), names: async () => ["aws-mumbai", "box"], remove: async (n) => void removed.push(n) });
        const no = ctx({ servers: s, confirm: () => "no", mode: "bypassPermissions" });
        expect((await ServerRemoveTool.run({ name: "aws-mumbai" }, no.c)).content).toContain("aws-mumbai is untouched");
        expect(no.asked).toEqual([{ title: "Delete aws-mumbai", facts: [["Where", "AWS Lightsail · Mumbai"], ["Cost", "$12/month"]], commands: ["aws lightsail delete-instance --instance-name aws-mumbai"], yes: "Delete", no: "Cancel", danger: true }]);
        expect(removed).toEqual([]);
        const yes = await ServerRemoveTool.run({ name: "aws-mumbai" }, ctx({ servers: s, confirm: () => "yes" }).c);
        expect(yes.content).toContain("aws-mumbai is deleted");
        // One that's only forgotten: asked in a mode that asks, not in Bypass.
        const manual = ctx({ servers: s, confirm: () => "yes", mode: "default" });
        expect((await ServerRemoveTool.run({ name: "box" }, manual.c)).content).toContain("box is forgotten here. Nothing on the server was touched");
        expect(manual.asked[0]).toMatchObject({ title: "Remove box from Cavvy", yes: "Remove" });
        const quiet = ctx({ servers: s, mode: "bypassPermissions" });
        await ServerRemoveTool.run({ name: "box" }, quiet.c);
        expect(quiet.asked).toEqual([]);
        expect(removed).toEqual(["aws-mumbai", "box", "box"]);
        expect((await ServerRemoveTool.run({ name: "nope" }, ctx({ servers: s }).c)).content).toBe("No server is called nope. The user's servers: aws-mumbai, box.");
    });

    test("the sign-ins asked for inside a call have a limit of their own, so the call answers before an agent CLI gives up on it", async () => {
        const asked: any[] = [];
        const ui = { requestSignIn: async (req: any) => (asked.push(req), { text: "The user hasn't signed in yet.", summary: "Still waiting", signedIn: false }) };
        const add = ctx({ servers: servers() });
        Object.assign(add.c.ui, ui);
        const r = await ServerAddTool.run({ name: "box", address: "dev@box.example" }, add.c);
        expect(asked[0]).toMatchObject({ machine: "box", waitMs: 20 * 60_000, targets: [{ target: "claude" }, { target: "codex" }, { target: "gh" }] });
        // The server is added whatever becomes of its sign-ins.
        expect(r.content).toContain("box is one of the user's servers now.");
        expect(r.content).toContain("The user hasn't signed in yet.");
        const remove = ctx({ servers: servers({ get: async () => ({ destination: "a@b" }), remove: async (_n, o) => void (await o.signIn("aws")) }), confirm: () => "yes" });
        Object.assign(remove.c.ui, ui);
        await ServerRemoveTool.run({ name: "box" }, remove.c);
        expect(asked[1]).toMatchObject({ targets: [{ target: "aws" }], waitMs: 20 * 60_000 });
    });

    test("served to Claude Code and Codex under their own names", () => {
        const tools = serverServerTools(async () => ({ text: "Call ServerAdd next, after RequestSignIn." }));
        expect(tools.map((t) => t.name)).toEqual(["server_key", "server_add", "server_remove"]);
        for (const t of tools) expect(t.description).not.toMatch(/ServerKey|ServerAdd|ServerRemove|RequestSignIn/);
        expect(tools[2]!.annotations).toMatchObject({ destructiveHint: true });
    });
});

/** A window on this machine's Cavvy. */
class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    views = new Map<string, { state: SessionState; turns: Turn[]; agents: any[]; seq: number }>();
    events: ServerEvent[] = [];
    private listeners = new Set<() => void>();
    constructor() {
        this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", "auth.mine"] } as any);
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) {
                const ev = msg.event as ServerEvent;
                this.events.push(ev);
                if (ev.type === "session.ops") {
                    const v = this.views.get(ev.sessionId);
                    if (v && ev.seq > v.seq) {
                        for (const op of ev.ops) applyOp(v as any, op);
                        v.seq = ev.seq;
                    }
                }
                for (const l of this.listeners) l();
                return;
            }
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            if (msg.error) w?.reject(new Error(msg.error.message));
            else w?.resolve(msg.result);
        };
    }
    opened() {
        return new Promise<void>((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error("connection failed"));
        });
    }
    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    }
    async session(cwd: string, mode: string) {
        const snap = await this.call<SessionSnapshot>("session.create", { cwd });
        this.views.set(snap.state.id, { state: snap.state, turns: snap.turns, agents: snap.agents, seq: snap.seq });
        await this.call("session.setMode", { id: snap.state.id, mode });
        return snap.state.id;
    }
    view(id: string) {
        return this.views.get(id)!;
    }
    until(id: string, pred: (v: { state: SessionState; turns: Turn[] }) => boolean, what: string, ms = 30_000): Promise<void> {
        return new Promise((resolve, reject) => {
            const check = () => {
                const v = this.views.get(id);
                if (!v || !pred(v)) return;
                this.listeners.delete(check);
                clearTimeout(t);
                resolve();
            };
            const t = setTimeout(() => {
                this.listeners.delete(check);
                reject(new Error(`timed out waiting for ${what}; card ${JSON.stringify(this.views.get(id)?.state.interactions[0])}; last ${JSON.stringify(this.views.get(id)?.turns.at(-1)?.blocks.at(-1)).slice(0, 600)}`));
            }, ms);
            this.listeners.add(check);
            check();
        });
    }
    async card<K extends "confirm" | "signin">(id: string, kind: K, ok: (i: any) => boolean = () => true): Promise<K extends "confirm" ? ConfirmInteraction : SignInInteraction> {
        const find = (v: { state: SessionState }) => v.state.interactions.find((i) => i.kind === kind && ok(i));
        await this.until(id, (v) => Boolean(find(v)), `a ${kind} card`);
        return find(this.view(id)) as any;
    }
}

const lastTurn = (v: { turns: Turn[] }) => v.turns[v.turns.length - 1]!;
const done = (v: { state: SessionState; turns: Turn[] }) => !v.state.busy && v.turns.length > 0 && lastTurn(v).status !== "running";
const said = (t: Turn) => t.blocks.filter((b): b is Extract<Turn["blocks"][number], { t: "text" }> => b.t === "text").map((b) => b.text).join("\n");

describe("from a window, with an agent doing it", () => {
    test("create: the price is asked in Bypass, the new machine is waited for and added with no key file and no trust question, and its sign-ins are offered", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        await c.call("session.send", { id, text: "newserver aws-mumbai dev@new.example" });

        const price = await c.card(id, "confirm");
        expect(price).toMatchObject({ title: "Create a server for $12/month", yes: "Create", other: "Change…", no: "Cancel", facts: [["Name", "aws-mumbai"], ["Where", "AWS Lightsail · Mumbai"], ["Size", "2 CPUs · 2 GB · 60 GB"], ["System", "Ubuntu 24.04"]] });
        expect(c.view(id).state.status).toBe("waiting");
        // Nothing exists until the user says so.
        expect(madeKey("aws-mumbai")).toBeUndefined();
        await c.call("session.respond", { id, interactionId: price.id, response: { kind: "confirm", choice: "yes" } });

        // The machine "starts": at first it shows the identity its image came with, then the one it was given.
        const until = Date.now() + 10_000;
        while (!madeKey("aws-mumbai") && Date.now() < until) await Bun.sleep(20);
        const made = madeKey("aws-mumbai")!;
        await Bun.sleep(400);
        expect(getServer("aws-mumbai")).toBeUndefined();
        fake.showHostKey(made.hostPublicKey);

        // Its sign-ins, in one card: what's signed in says who, what isn't offers to.
        const list = await c.card(id, "signin", (i) => i.step === "list");
        expect(list.machine).toBe("aws-mumbai");
        expect(list.rows).toEqual([{ target: "claude", name: "Claude Code", state: "in", who: "me@example.com" }, { target: "codex", name: "Codex", state: "out" }, { target: "gh", name: "GitHub", state: "out" }]);
        // It's listed already, with what it costs: the sign-ins aren't what adds it.
        const entry = getServer("aws-mumbai")!;
        expect(entry).toMatchObject({ destination: "dev@new.example", identityFile: made.identityFile, knownHostsFile: ownKnownHosts(), cloud: { provider: "AWS Lightsail", where: "Mumbai", cost: "$12/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "aws-mumbai"]] } });
        expect((await c.call("servers.list")).servers).toEqual([{ name: "aws-mumbai", destination: "dev@new.example", connected: false, cost: "$12/month", rented: true }]);
        expect(c.events.some((e) => e.type === "servers.changed" && e.count === 1)).toBe(true);
        // No trust question was asked, and the user's own known_hosts wasn't touched: the identity was known beforehand.
        expect(c.view(id).turns.flatMap((t) => t.blocks).some((b) => JSON.stringify(b).includes("Trust "))).toBe(false);
        expect(fake.knownHosts()).not.toContain("new.example");
        // The script, with the server's private key in it, is gone once it's added.
        expect(readFileSync(join(serverKeysDir(), "aws-mumbai.host.pub"), "utf-8")).toContain("ssh-ed25519");
        expect(existsSync(join(serverKeysDir(), "aws-mumbai.script"))).toBe(false);

        // GitHub there: it can take a token, so it asks how; then the code, and back to the list with who.
        const step = (action: Record<string, unknown>) => c.call("session.respond", { id, interactionId: list.id, response: { kind: "signin", ...action } });
        await step({ action: "pick", target: "gh" });
        const ask = await c.card(id, "signin", (i) => i.step === "ask");
        expect(ask).toMatchObject({ name: "GitHub", machine: "aws-mumbai", warning: "Agents there can push as you", canToken: true, back: true });
        await step({ action: "start" });
        expect(await c.card(id, "signin", (i) => i.step === "code")).toMatchObject({ code: "ABCD-1234", site: "github.com/login/device" });
        writeFileSync(join(fake.home, "gh-approve"), "");
        const back = await c.card(id, "signin", (i) => i.step === "list" && i.rows?.find((r: any) => r.target === "gh")?.state === "in");
        expect(back.rows!.find((r) => r.target === "gh")).toEqual({ target: "gh", name: "GitHub", state: "in", who: "octo" });
        await step({ action: "later" });

        await c.until(id, done, "the turn's end");
        const text = said(lastTurn(c.view(id)));
        expect(text).toContain("aws-mumbai is one of the user's servers now ($12/month). Sessions there run without asking (Bypass).");
        expect(text).toContain("Signed in to Claude Code on aws-mumbai as me@example.com.");
        expect(text).toContain("Signed in to GitHub on aws-mumbai as octo.");
        expect(text).toContain("Not signed in to Codex on aws-mumbai: the user chose Later.");
        // What was put off stays reachable.
        expect(c.view(id).state.watches).toEqual([{ id: "sign-in:aws-mumbai:codex", kind: "sign-in", label: "Sign in to Codex on aws-mumbai" }]);
        await c.call("session.stopWatch", { id, watchId: "sign-in:aws-mumbai:codex" });
        c.ws.close();
    });

    test("Change… and Cancel create nothing", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        await c.call("session.send", { id, text: "newserver other-one dev@other.example" });
        const price = await c.card(id, "confirm");
        await c.call("session.respond", { id, interactionId: price.id, response: { kind: "confirm", choice: "other" } });
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toBe("A small one in Mumbai fits.\nWhat would you like instead?");
        expect(madeKey("other-one")).toBeUndefined();
        await c.call("session.send", { id, text: "newserver other-one dev@other.example" });
        const again = await c.card(id, "confirm");
        // Esc, or a window closing the card, is a no. So is an answer the card didn't offer.
        await expect(c.call("session.respond", { id, interactionId: again.id, response: { kind: "permission", choice: "yes" } })).rejects.toThrow("doesn't match");
        await c.call("session.respond", { id, interactionId: again.id, response: { kind: "confirm", choice: "maybe" } });
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toContain("Nothing was created.");
        expect(madeKey("other-one")).toBeUndefined();
        expect(getServer("other-one")).toBeUndefined();
        c.ws.close();
    });

    test("a server the user already has: its key is shown for their word, and without it nothing is added", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        fake.restoreHostKey();
        await c.call("session.send", { id, text: "addserver box dev@box.example" });
        const trust = await c.card(id, "confirm");
        expect(trust).toMatchObject({ title: "Trust box.example", yes: "Trust", no: "Cancel", facts: [["Key", expect.stringMatching(/^SHA256:\S+ \(ED25519\)$/)]] });
        await c.call("session.respond", { id, interactionId: trust.id, response: { kind: "confirm", choice: "no" } });
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toContain("box wasn't added: The user didn't trust box.example's key.");
        expect(getServer("box")).toBeUndefined();

        await c.call("session.send", { id, text: "addserver box dev@box.example" });
        const again = await c.card(id, "confirm");
        await c.call("session.respond", { id, interactionId: again.id, response: { kind: "confirm", choice: "yes" } });
        // Then its sign-ins, as for any server.
        const list = await c.card(id, "signin", (i) => i.step === "list");
        await c.call("session.respond", { id, interactionId: list.id, response: { kind: "signin", action: "later" } });
        await c.until(id, done, "the turn's end");
        expect(getServer("box")).toMatchObject({ destination: "dev@box.example" });
        expect(getServer("box")!.identityFile).toBeUndefined();
        expect(fake.knownHosts()).toContain("box.example ");
        for (const w of c.view(id).state.watches ?? []) await c.call("session.stopWatch", { id, watchId: w.id });
        c.ws.close();
    });

    test("delete: asked in Bypass with the commands shown; the provider's sign-in is asked for on the way; then the machine, the server and its keys are gone", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        const made = madeKey("aws-mumbai") ?? { hostPublicKey: readFileSync(join(serverKeysDir(), "aws-mumbai.host.pub"), "utf-8") };
        fake.showHostKey(made.hostPublicKey);
        await c.call("session.send", { id, text: "deleteserver aws-mumbai" });
        const ask = await c.card(id, "confirm");
        expect(ask).toMatchObject({ title: "Delete aws-mumbai", danger: true, yes: "Delete", no: "Cancel", facts: [["Where", "AWS Lightsail · Mumbai"], ["Cost", "$12/month"]], commands: ["aws lightsail delete-instance --instance-name aws-mumbai"] });
        expect(existsSync(join(cloud, "calls"))).toBe(false);
        await c.call("session.respond", { id, interactionId: ask.id, response: { kind: "confirm", choice: "yes" } });

        // The provider's CLI is signed out: its card, then the same command again.
        const signIn = await c.card(id, "signin", (i) => i.step === "ask");
        expect(signIn).toMatchObject({ name: "AWS", target: "aws" });
        expect(signIn.machine).toBeUndefined();
        await c.call("session.respond", { id, interactionId: signIn.id, response: { kind: "signin", action: "start" } });
        await c.card(id, "signin", (i) => i.step === "browser" && Boolean(i.url));
        writeFileSync(join(cloud, "approve"), "");
        await c.until(id, done, "the turn's end");
        expect(said(lastTurn(c.view(id)))).toContain("aws-mumbai is deleted");
        expect(readFileSync(join(cloud, "deleted"), "utf-8")).toBe("deleted\n");
        expect(readFileSync(join(cloud, "calls"), "utf-8").split("\n").filter((l) => l.startsWith("lightsail delete-instance"))).toEqual(["lightsail delete-instance --instance-name aws-mumbai", "lightsail delete-instance --instance-name aws-mumbai"]);
        expect(getServer("aws-mumbai")).toBeUndefined();
        expect(existsSync(join(serverKeysDir(), "aws-mumbai"))).toBe(false);
        expect(readFileSync(ownKnownHosts(), "utf-8")).not.toMatch(/^new\.example /m);
        expect(listServers().map((s) => s.name)).toEqual(["box"]);
        expect(c.events.filter((e) => e.type === "servers.changed").at(-1)).toMatchObject({ count: 1 });
        c.ws.close();
    });

    test("a teardown that stops part way goes on from there next time, not from a resource that's already gone", async () => {
        const { serverSetup } = await import("../src/servers/agent-setup");
        const { ServerLinks } = await import("../src/servers/manager");
        const { saveServer } = await import("../src/servers/store");
        const links = new ServerLinks();
        const setup = serverSetup({ links: async () => links, settings: () => ({}) });
        // This test's own pretend CLI; the one the other tests use is put back at its end.
        const usual = readFileSync(join(mine, "aws"), "utf-8");
        saveServer({ ...getServer("box")!, name: "two-step", cloud: { provider: "AWS Lightsail", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "two-step"], ["aws", "lightsail", "release-static-ip", "--static-ip-name", "two-step-ip"]] } });
        // The pretend CLI: the instance deletes once (a second try would find nothing), the address is refused at first.
        writeFileSync(join(mine, "aws"), `#!/bin/sh
d=${JSON.stringify(cloud)}
echo "$*" >> "$d/calls2"
case "$1 $2" in
"lightsail delete-instance") [ -e "$d/gone" ] && { echo "An error occurred (NotFoundException): The Instance does not exist"; exit 254; }; touch "$d/gone"; exit 0 ;;
"lightsail release-static-ip") [ -e "$d/allow-ip" ] || { echo "An error occurred (ServiceException): try again later"; exit 254; }; exit 0 ;;
esac
exit 0
`);
        const o = { signal: new AbortController().signal, progress: () => undefined, signIn: async () => false };
        const failed = await setup.remove("two-step", o).then(() => "", (e: Error) => e.message);
        expect(failed).toContain("release-static-ip --static-ip-name two-step-ip` failed");
        // The way out when what's left is already gone.
        expect(failed).toContain("they can forget two-step in Servers, which deletes nothing");
        // What's done is done: only what's left is recorded.
        expect(getServer("two-step")!.cloud!.teardown).toEqual([["aws", "lightsail", "release-static-ip", "--static-ip-name", "two-step-ip"]]);
        writeFileSync(join(cloud, "allow-ip"), "");
        await setup.remove("two-step", o);
        expect(getServer("two-step")).toBeUndefined();
        expect(readFileSync(join(cloud, "calls2"), "utf-8").trim().split("\n")).toEqual(["lightsail delete-instance --instance-name two-step", "lightsail release-static-ip --static-ip-name two-step-ip", "lightsail release-static-ip --static-ip-name two-step-ip"]);
        // A provider CLI that's signed out, and a user who doesn't sign in: said as that, with nothing deleted.
        saveServer({ ...getServer("box")!, name: "signed-out", cloud: { provider: "AWS", teardown: [["aws", "ec2", "terminate-instances"]] } });
        writeFileSync(join(mine, "aws"), `#!/bin/sh\necho "aws: [ERROR]: Unable to locate credentials."\nexit 253\n`);
        await expect(setup.remove("signed-out", o)).rejects.toThrow("AWS isn't signed in on this machine, so `aws ec2 terminate-instances` didn't run. Call ServerRemove again once it is.");
        expect(getServer("signed-out")).toBeDefined();
        const { removeServer } = await import("../src/servers/store");
        removeServer("signed-out");
        writeFileSync(join(mine, "aws"), usual);
    });

    test("a step that finished as the teardown was interrupted is done: the next try doesn't run it again", async () => {
        const { serverSetup } = await import("../src/servers/agent-setup");
        const { ServerLinks } = await import("../src/servers/manager");
        const { saveServer } = await import("../src/servers/store");
        const setup = serverSetup({ links: async () => new ServerLinks(), settings: () => ({}) });
        const usual = readFileSync(join(mine, "aws"), "utf-8");
        saveServer({ ...getServer("box")!, name: "cut-short", cloud: { provider: "AWS Lightsail", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "cut-short"], ["aws", "lightsail", "release-static-ip", "--static-ip-name", "cut-short-ip"]] } });
        // The pretend CLI finishes its delete whatever it's told meanwhile, as a request already sent does.
        const started = join(cloud, "cut-short-started");
        const finish = join(cloud, "cut-short-finish");
        writeFileSync(join(mine, "aws"), `#!/bin/sh\ntrap '' TERM\n{ pwd; ls -A; } > ${JSON.stringify(join(cloud, "cut-short-where"))}\ntouch ${JSON.stringify(started)}\ni=0; while [ ! -e ${JSON.stringify(finish)} ]; do sleep 0.05; i=$((i+1)); [ $i -gt 400 ] && exit 1; done\nexit 0\n`);
        try {
            const stop = new AbortController();
            const removing = setup.remove("cut-short", { signal: stop.signal, progress: () => undefined, signIn: async () => false });
            // Interrupted once it's under way, and not before.
            const end = Date.now() + 15_000;
            while (!existsSync(started) && Date.now() < end) await Bun.sleep(10);
            stop.abort();
            // Only now does it finish: after the interruption, whatever the machine was busy with.
            writeFileSync(finish, "");
            await expect(removing).rejects.toThrow("Stopped part way");
            // It ran in a folder of its own with nothing in it, not in the user's home.
            expect(readFileSync(join(cloud, "cut-short-where"), "utf-8").trim()).toMatch(/^\S*cavvy-teardown-\S+$/);
            expect(getServer("cut-short")!.cloud!.teardown).toEqual([["aws", "lightsail", "release-static-ip", "--static-ip-name", "cut-short-ip"]]);
        } finally {
            writeFileSync(join(mine, "aws"), usual);
            (await import("../src/servers/store")).removeServer("cut-short");
        }
    });

    test("what's run at the end is still only what a teardown may be", async () => {
        const { serverSetup } = await import("../src/servers/agent-setup");
        const { ServerLinks } = await import("../src/servers/manager");
        const { removeServer, saveServer } = await import("../src/servers/store");
        const setup = serverSetup({ links: async () => new ServerLinks(), settings: () => ({}) });
        const o = { signal: new AbortController().signal, progress: () => undefined, signIn: async () => false };
        const calls = () => (existsSync(join(cloud, "calls")) ? readFileSync(join(cloud, "calls"), "utf-8") : "");
        const before = calls();
        // A record from before the rule, or one changed by hand.
        for (const teardown of [[["gh", "repo", "delete", "acme/app", "--yes"]], [["aws", "lightsail", "delete-instance", "--instance-name", "odd"], ["aws", "ec2", "terminate-instances", "--cli-input-json", "file:///tmp/x.json"]]]) {
            saveServer({ ...getServer("box")!, name: "odd", cloud: { provider: "AWS", teardown } });
            await expect(setup.remove("odd", o)).rejects.toThrow("Nothing was deleted.");
            expect(getServer("odd")).toBeDefined();
            removeServer("odd");
        }
        // Not even the ones before it in the list ran.
        expect(calls()).toBe(before);
    });

    test("a machine an agent made can't take the address of a server the user has, and an add that fails puts back what Cavvy knew of the address", async () => {
        const { serverSetup } = await import("../src/servers/agent-setup");
        const { ServerLinks } = await import("../src/servers/manager");
        const { hostOf } = await import("../src/servers/ssh");
        const setup = serverSetup({ links: async () => new ServerLinks(), settings: () => ({}) });
        const o = { signal: new AbortController().signal, progress: () => undefined, trust: async () => false };
        const box = getServer("box")!;
        const made = await makeServerKey("twin");
        const known = () => (existsSync(ownKnownHosts()) ? readFileSync(ownKnownHosts(), "utf-8") : "");
        const before = known();
        await expect(setup.add({ name: "twin", address: `ubuntu@${hostOf(box)}`, port: box.port }, o)).rejects.toThrow("is the address of box, one of the user's servers already");
        expect(known()).toBe(before);
        // A machine that never shows the identity made for it: the address keeps what it had.
        writeFileSync(ownKnownHosts(), `${before}203.0.113.50 ssh-ed25519 AAAAbefore\n`);
        fake.restoreHostKey();
        const timing = { ...setupTiming };
        Object.assign(setupTiming, { readyMs: 300, everyMs: 50 });
        try {
            await expect(setup.add({ name: "twin", address: "ubuntu@203.0.113.50" }, o)).rejects.toThrow("didn't let Cavvy in");
        } finally {
            Object.assign(setupTiming, timing);
        }
        expect(known()).toContain("203.0.113.50 ssh-ed25519 AAAAbefore");
        expect(known()).not.toContain(made.hostPublicKey.split(" ")[1]!);
        expect(getServer("twin")).toBeUndefined();
        forgetServerKey("twin", "203.0.113.50");
        writeFileSync(ownKnownHosts(), before);
    });

    test("a teardown that fails leaves the server listed, with the provider's own words", async () => {
        const c = new Client();
        await c.opened();
        const id = await c.session(tempDir("cavvy-agent-setup-"), "bypassPermissions");
        const { saveServer } = await import("../src/servers/store");
        saveServer({ ...getServer("box")!, name: "rented", cloud: { provider: "AWS Lightsail", cost: "$5/month", teardown: [["aws", "lightsail", "delete-instance", "--instance-name", "rented"]] } });
        writeFileSync(join(cloud, "refuse"), "");
        await c.call("session.send", { id, text: "deleteserver rented" });
        const ask = await c.card(id, "confirm");
        await c.call("session.respond", { id, interactionId: ask.id, response: { kind: "confirm", choice: "yes" } });
        await c.until(id, done, "the turn's end");
        const text = said(lastTurn(c.view(id)));
        expect(text).toContain("rented wasn't removed: `aws lightsail delete-instance --instance-name rented` failed:");
        expect(text).toContain("AccessDeniedException");
        expect(text).toContain("still costs money");
        expect(getServer("rented")).toBeDefined();
        c.ws.close();
    });
});
