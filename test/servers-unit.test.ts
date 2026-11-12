// The parts of src/servers that decide things from text and files: what an
// ssh failure means, what may be a server's name, which build is newer, who
// is signed in, and what a settings copy carries.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { FAKE, isolate, tempDir } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

const iso = isolate();
// What ssh says about a server (`ssh -G`) decides some of this: the stand-in says it, not this machine's own config.
const fake = fakeSsh();
const { sshFailure, shQuote, remoteSh, sshCommandArgv, sshTunnelArgv, keyNeedsPassphrase, printable, offeredHostKey, trustHostKey, ownKnownHosts } = await import("../src/servers/ssh");
const { draftServer, saveServer, listServers, removeServer, requireServer, thisDesktop, serversFile, desktopIdFile } = await import("../src/servers/store");
const { compareBuilds, guiAvailable, guiChangedSince, serverBuild, SERVER_BUN, thisBuild } = await import("../src/servers/build");
const { parseFacts, targetFor, checkRoom } = await import("../src/servers/remote");
const { MachineSignIns } = await import("../src/servers/host");
const { planCopy, portableMcpEntry, portableMcpServer, portableRule, portableSettings, describeCopy, describeLeft, countCopied } = await import("../src/servers/copy");
const { checkLines, parseServerSpec } = await import("../src/servers/cli");
const { UNIT } = await import("../src/servers/service");
import type { ServerEntry } from "../src/servers/store";

const entry: ServerEntry = { name: "box", destination: "dev@box.example", addedAt: "2026-01-01T00:00:00.000Z" };

afterAll(() => {
    fake.cleanup();
    iso.cleanup();
});

describe("what an ssh failure means", () => {
    // ssh's own words, as OpenSSH prints them.
    test.each([
        ["ssh: connect to host box.example port 22: Operation timed out", "unreachable"],
        ["ssh: connect to host box.example port 22: Connection timed out", "unreachable"],
        ["ssh: connect to host box.example port 22: Connection refused", "unreachable"],
        ["ssh: connect to host box.example port 22: No route to host", "unreachable"],
        ["ssh: connect to host box.example port 22: Network is unreachable", "unreachable"],
        ["ssh: Could not resolve hostname box.example: Name or service not known", "unreachable"],
        ["ssh: Could not resolve hostname box.example: nodename nor servname provided, or not known", "unreachable"],
        ["ssh: Could not resolve hostname box.example: Temporary failure in name resolution", "unreachable"],
        ["kex_exchange_identification: Connection closed by remote host\nConnection closed by 192.0.2.7 port 22", "unreachable"],
        ["Connection reset by 192.0.2.7 port 22", "unreachable"],
        ["client_loop: send disconnect: Broken pipe", "unreachable"],
        ["Timeout, server box.example not responding.", "unreachable"],
        ["Connection to box.example closed by remote host.", "unreachable"],
        // Off the network in ways that word it differently: still only "can't reach it".
        ["ssh: connect to host box.example port 22: Network is down", "unreachable"],
        ["ssh: connect to host box.example port 22: Can't assign requested address", "unreachable"],
        ["ssh: connect to host box.example port 22: Software caused connection abort", "unreachable"],
        ["dev@box.example: Permission denied (publickey).", "auth"],
        ["dev@box.example: Permission denied (publickey,password).", "auth"],
        ["Received disconnect from 192.0.2.7 port 22:2: Too many authentication failures", "auth"],
        ["No ED25519 host key is known for box.example and you have requested strict checking.\nHost key verification failed.", "host-unknown"],
        ["@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@\nOffending ED25519 key in /Users/me/.ssh/known_hosts:12\nHost key for box.example has changed and you have requested strict checking.\nHost key verification failed.", "host-changed"],
        ["something ssh has never said before", "other"],
    ] as const)("%p is %s", (stderr, kind) => {
        expect(sshFailure(stderr, entry).kind).toBe(kind);
    });

    test("only a server that can't be reached is worth trying again by itself", () => {
        const permanent = (stderr: string) => sshFailure(stderr, entry).permanent;
        expect(permanent("ssh: connect to host box.example port 22: Connection refused")).toBe(false);
        expect(permanent("dev@box.example: Permission denied (publickey).")).toBe(true);
        expect(permanent("Host key verification failed.")).toBe(true);
        expect(permanent("Host key for box.example has changed and you have requested strict checking.")).toBe(true);
    });

    test("a changed key: the fix names this server as ssh keeps it, and the file only when it isn't the usual one", () => {
        const changed = "Host key for box.example has changed and you have requested strict checking.\nHost key verification failed.";
        fake.settings(["userknownhostsfile ~/.ssh/known_hosts"]);
        try {
            expect(sshFailure(changed, entry).fix).toBe("ssh-keygen -R box.example");
            expect(sshFailure(changed, { ...entry, port: 2222 }).fix).toBe("ssh-keygen -R '[box.example]:2222'");
            fake.settings(["hostkeyalias build-box", "userknownhostsfile /etc/ssh/known"]);
            expect(sshFailure(changed, entry).fix).toBe("ssh-keygen -R build-box -f /etc/ssh/known");
        } finally {
            fake.settings();
        }
        expect(sshFailure("ssh: connect to host box.example port 22: Connection refused", entry).detail).toBe("ssh: connect to host box.example port 22: Connection refused");
    });

    test("a server can't have another host's key forgotten: the fix never takes a name or a file from the failure's text", () => {
        // What a command on the server could print, exiting as ssh does when it fails.
        const forged = "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nOffending ED25519 key in /Users/me/.ssh/known_hosts:7\nHost key for github.com has changed and you have requested strict checking.\nHost key verification failed.";
        fake.settings(["userknownhostsfile ~/.ssh/known_hosts"]);
        try {
            const e = sshFailure(forged, entry);
            expect(e.message).toBe("box.example's identity changed.");
            expect(e.fix).toBe("ssh-keygen -R box.example");
        } finally {
            fake.settings();
        }
    });

    test("nothing a server says can draw on the terminal", () => {
        const e = sshFailure("\u001b[2J\u001b]0;owned\u0007ssh: something \u009bodd\r\n", entry);
        expect(e.detail).toBe("[2J]0;ownedssh: something odd");
        expect(printable("a\tb\nc\u0000\u001b[31m")).toBe("a\tb\nc[31m");
        expect(printable("x".repeat(500)).length).toBe(300);
    });

    test("a key file ssh won't use, or can't find, is said as that and not as a refusal", () => {
        const withKey = { ...entry, identityFile: "~/.ssh/box" };
        const open = sshFailure("@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\nPermissions 0644 for '/Users/me/.ssh/box' are too open.\nLoad key \"/Users/me/.ssh/box\": bad permissions\ndev@box.example: Permission denied (publickey).", withKey);
        expect([open.kind, open.message]).toEqual(["identity", "ssh won't use the key at ~/.ssh/box."]);
        const missing = sshFailure("Warning: Identity file /Users/me/.ssh/box not accessible: No such file or directory.\ndev@box.example: Permission denied (publickey).", withKey);
        expect([missing.kind, missing.message]).toEqual(["identity", "Can't read the key at ~/.ssh/box."]);
    });

    const keys = tempDir("cavvy-servers-key-");
    const locked = join(keys, "locked");
    const open = join(keys, "open");
    const denied = "dev@box.example: Permission denied (publickey).";

    test("a key that needs its passphrase is said as that, with the command that loads it", () => {
        expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "a passphrase", "-f", locked]).exitCode).toBe(0);
        expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", open]).exitCode).toBe(0);
        expect(keyNeedsPassphrase(locked)).toBe(true);
        expect(keyNeedsPassphrase(open)).toBe(false);
        const e = sshFailure(denied, { ...entry, identityFile: locked });
        expect([e.kind, e.message, e.fix]).toEqual(["passphrase", "This key needs its passphrase. Add it to ssh-agent, then retry.", `ssh-add ${locked}`]);
        expect(sshFailure(denied, { ...entry, identityFile: open }).message).toBe("box.example refused this key.");
    });

    test("so is the key ssh picks by itself: the usual ones, or one its config names", () => {
        fake.settings([`identityfile ${join(keys, "missing")}`, `identityfile ${open}`, `identityfile ${locked}`]);
        try {
            const e = sshFailure(denied, entry);
            expect([e.kind, e.message, e.fix]).toEqual(["passphrase", "Your SSH key needs its passphrase. Add it to ssh-agent, then retry.", `ssh-add ${locked}`]);
            // With none of them locked, the server refused them.
            fake.settings([`identityfile ${open}`]);
            expect([sshFailure(denied, entry).kind, sshFailure(denied, entry).message]).toEqual(["auth", "box.example refused your SSH keys."]);
        } finally {
            fake.settings();
        }
    });

    test("a locked key the agent holds, refused, is the server's refusal: loading it again would change nothing", async () => {
        // An agent of the test's own, with the key in it.
        const sock = `/tmp/cv-agent-${process.pid}.sock`;
        const agent = Bun.spawn(["ssh-agent", "-D", "-a", sock], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        const askpass = join(keys, "askpass.sh");
        writeFileSync(askpass, "#!/bin/sh\necho 'a passphrase'\n");
        chmodSync(askpass, 0o755);
        const before = process.env.SSH_AUTH_SOCK;
        try {
            for (let i = 0; i < 100 && !existsSync(sock); i++) await Bun.sleep(20);
            const add = Bun.spawnSync(["ssh-add", locked], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, SSH_AUTH_SOCK: sock, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0" } as Record<string, string> });
            expect(add.stderr.toString() + add.exitCode).toContain("Identity added");
            process.env.SSH_AUTH_SOCK = sock;
            const e = sshFailure(denied, { ...entry, identityFile: locked });
            expect([e.kind, e.message]).toEqual(["auth", "box.example refused this key."]);

            // The agent asked is the one ssh would use for that server, which its config may name (a password manager's).
            delete process.env.SSH_AUTH_SOCK;
            expect(sshFailure(denied, { ...entry, identityFile: locked }).kind).toBe("passphrase");
            fake.settings([`identityagent ${sock}`]);
            expect(sshFailure(denied, { ...entry, identityFile: locked }).kind).toBe("auth");
            // And where the config says to use none, a key in the usual agent doesn't count.
            process.env.SSH_AUTH_SOCK = sock;
            fake.settings(["identityagent none"]);
            expect(sshFailure(denied, { ...entry, identityFile: locked }).kind).toBe("passphrase");
        } finally {
            fake.settings();
            if (before === undefined) delete process.env.SSH_AUTH_SOCK;
            else process.env.SSH_AUTH_SOCK = before;
            agent.kill();
            await agent.exited;
        }
    });
});

describe("trusting a server's key", () => {
    test("where the user's ssh config keeps no keys for it, the key goes in Cavvy's own file, once, and the server remembers that", async () => {
        const e = { ...entry, destination: "dev@passing.example" };
        fake.settings(["userknownhostsfile /dev/null"]);
        try {
            const key = await offeredHostKey(e);
            // The look at the key runs Cavvy's own command too, whatever the user's config would run there.
            expect(fake.calls().findLast((c) => c.opts.StrictHostKeyChecking === "no")!.opts).toMatchObject({ RemoteCommand: "none", PreferredAuthentications: "none" });
            const trusted = trustHostKey(e, key);
            expect(trusted.knownHostsFile).toBe(ownKnownHosts());
            expect(readFileSync(ownKnownHosts(), "utf-8").trim().split("\n")).toEqual(key.lines);
            // Its connections name that file, so the key is found (the stand-in refuses a host it isn't given a key for).
            expect(sshCommandArgv(trusted, "true")).toContain(`UserKnownHostsFile=${ownKnownHosts()}`);
            const { ssh } = await import("../src/servers/ssh");
            expect((await ssh(trusted, "echo there")).stdout).toBe("there\n");
            await expect(ssh(e, "echo there")).rejects.toMatchObject({ kind: "host-unknown" });
            // Trusted again, nothing is added twice.
            trustHostKey(trusted, key);
            expect(readFileSync(ownKnownHosts(), "utf-8").trim().split("\n")).toEqual(key.lines);
        } finally {
            fake.settings();
        }
    });
});

describe("the command line ssh gets", () => {
    test("the destination comes after --, nothing asks or accepts a key, and the user's shared connections aren't used", () => {
        {
            const argv = sshCommandArgv({ ...entry, port: 2222, identityFile: "/keys/box" }, "true");
            expect(argv.slice(-4)).toEqual(["-T", "--", "dev@box.example", "true"]);
            const opts = argv.flatMap((a, i) => (argv[i - 1] === "-o" ? [a] : []));
            expect(opts).toEqual(expect.arrayContaining(["BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ControlMaster=no", "ControlPath=none", "ClearAllForwardings=yes", "IdentitiesOnly=yes"]));
            expect(argv[0]).toBe(fake.bin);
            expect(argv.join(" ")).not.toMatch(/accept-new|StrictHostKeyChecking=no/);
            expect(argv).toEqual(expect.arrayContaining(["-p", "2222", "-i", "/keys/box"]));
            const tunnel = sshTunnelArgv(entry, 5001, 6001);
            expect(tunnel.slice(-6)).toEqual(["-N", "-T", "-L", "127.0.0.1:5001:127.0.0.1:6001", "--", "dev@box.example"]);
            expect(tunnel).toContain("ExitOnForwardFailure=yes");
            expect(tunnel).not.toContain("ClearAllForwardings=yes");
            // Whatever the user's config would run there, the command is Cavvy's.
            expect(opts).toContain("RemoteCommand=none");
        }
    });

    test("a script's arguments reach it as they were, whatever is in them", () => {
        const args = ["plain", "two words", "it's", '"quoted"', "$HOME `id` $(id)", "semi;colon && more", "", "-n", "new\nline", "~/x", "=ls", "a=b"];
        const r = Bun.spawnSync(["sh", "-c", remoteSh('for a in "$@"; do printf "%s\\0" "$a"; done', args)]);
        expect(r.stdout.toString().split("\0").slice(0, -1)).toEqual(args);
        expect(shQuote("safe-word_1.2/x")).toBe("safe-word_1.2/x");
        // zsh would look a bare `=ls` up as a command.
        expect(shQuote("=ls")).toBe("'=ls'");
    });
});

describe("the saved servers", () => {
    test("names and destinations that could be read as something else are refused", () => {
        for (const name of ["", "Box", "-box", "a b", "x".repeat(41), "box;rm"]) expect(() => draftServer({ name, destination: "dev@box.example" })).toThrow(/name is lowercase/);
        for (const destination of ["", "-oProxyCommand=evil", "dev@box example", "dev@box;id", "$(id)@box", "dev@box\nx", "ssh://dev@box/path"]) expect(() => draftServer({ name: "box", destination })).toThrow(/isn't an SSH destination/);
        for (const destination of ["box", "dev@box.example", "dev@192.0.2.7", "dev@[2001:db8::1]", "my_alias-2"]) expect(draftServer({ name: "box", destination }).destination).toBe(destination);
        expect(() => draftServer({ name: "box", destination: "dev@box", port: 70000 })).toThrow(/port/);
    });

    test("a key file named from the folder it was added in is kept as its full path; one from home stays from home", () => {
        expect(draftServer({ name: "box", destination: "dev@box", identityFile: "keys/box.pem" }).identityFile).toBe(join(process.cwd(), "keys", "box.pem"));
        expect(draftServer({ name: "box", destination: "dev@box", identityFile: "./box.pem" }).identityFile).toBe(join(process.cwd(), "box.pem"));
        expect(draftServer({ name: "box", destination: "dev@box", identityFile: "~/.ssh/box" }).identityFile).toBe("~/.ssh/box");
        expect(draftServer({ name: "box", destination: "dev@box", identityFile: "/keys/box" }).identityFile).toBe("/keys/box");
    });

    test("saved, listed, removed and put back; the file is the user's alone and holds no sign-in", () => {
        const e = saveServer(draftServer({ name: "box", destination: "dev@box.example", port: 2222, identityFile: "~/.ssh/box" }));
        expect(() => draftServer({ name: "box", destination: "other@host" })).toThrow("There's already a server named box.");
        expect(listServers()).toEqual([e]);
        const id = thisDesktop().id;
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(thisDesktop().id).toBe(id);
        expect(Object.keys(JSON.parse(readFileSync(serversFile(), "utf-8"))).sort()).toEqual(["servers"]);
        expect(readFileSync(desktopIdFile(), "utf-8")).toBe(`${id}\n`);
        expect(lstatSync(desktopIdFile()).mode & 0o777).toBe(0o600);
        expect(Object.keys(e).sort()).toEqual(["addedAt", "destination", "identityFile", "name", "port"]);
        const removed = removeServer("box");
        expect(listServers()).toEqual([]);
        expect(() => requireServer("box")).toThrow("No server named box. Add one with: cavvy servers add <name> <user@host>");
        saveServer(removed);
        expect(listServers()).toEqual([e]);
        expect(thisDesktop().id).toBe(id);
        removeServer("box");
    });
});

describe("which build is newer", () => {
    const repo = tempDir("cavvy-servers-git-");
    const git = (...args: string[]) => {
        const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, env: { PATH: process.env.PATH!, HOME: repo, GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    const commit = (msg: string) => (git("commit", "-q", "--allow-empty", "-m", msg), git("rev-parse", "HEAD").slice(0, 12));
    const first = commit("one");
    const second = commit("two");
    git("checkout", "-q", "-b", "side", first);
    const side = commit("aside");

    test("by the commits they're from, when this checkout has both", () => {
        expect(compareBuilds(first, second, repo)).toBe("older");
        expect(compareBuilds(second, first, repo)).toBe("newer");
        expect(compareBuilds(second, second, repo)).toBe("same");
        expect(compareBuilds(side, second, repo)).toBe("different");
    });

    test("a build with changes on top, or from a commit this checkout doesn't have, is only different", () => {
        expect(compareBuilds(`${first}-0a1b2c3d`, second, repo)).toBe("different");
        expect(compareBuilds(first, `${second}-0a1b2c3d`, repo)).toBe("different");
        expect(compareBuilds("0123456789ab", second, repo)).toBe("different");
        expect(compareBuilds("unknown-build", second, repo)).toBe("different");
    });

    test("a GUI that didn't build is tried again once something that could have fixed it is newer", async () => {
        // What the build is made from, in a pretend checkout: the built GUI, its dependencies, its lockfile.
        const root = tempDir("cavvy-servers-gui-");
        mkdirSync(join(root, "gui", "dist"), { recursive: true });
        mkdirSync(join(root, "gui", "node_modules"));
        writeFileSync(join(root, "gui", "dist", "index.html"), "");
        writeFileSync(join(root, "gui", "bun.lock"), "");
        const old = new Date("2026-01-01T00:00:00Z");
        for (const f of ["dist/index.html", "node_modules", "bun.lock"]) utimesSync(join(root, "gui", f), old, old);
        expect(guiChangedSince(old.getTime() + 1000, root)).toBe(false);
        // The user builds it by hand, as they're told to; or installs its dependencies again.
        utimesSync(join(root, "gui", "dist", "index.html"), new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
        expect(guiChangedSince(old.getTime() + 1000, root)).toBe(true);
        utimesSync(join(root, "gui", "dist", "index.html"), old, old);
        utimesSync(join(root, "gui", "node_modules"), new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
        expect(guiChangedSince(old.getTime() + 1000, root)).toBe(true);
        expect(guiChangedSince(Date.now(), join(root, "nowhere"))).toBe(false);

        // And the kept build goes by that: used while nothing has changed, made again once something has.
        const id = "eeeeeeeeeeee-5";
        const dir = join(iso.home, "cache", "server-builds", id, "linux-x64");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "bundle.tar.gz"), "kept");
        writeFileSync(join(dir, "bundle.json"), JSON.stringify({ sha256: "a".repeat(64), gui: false, guiFailed: true }));
        const before = process.env.CAVVY_BUILD;
        process.env.CAVVY_BUILD = id;
        try {
            const later = new Date(Date.now() + 86_400_000);
            utimesSync(join(dir, "bundle.json"), later, later);
            expect(await serverBuild("linux-x64")).toMatchObject({ id, gui: false, sha256: "a".repeat(64) });
            utimesSync(join(dir, "bundle.json"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
            // Stopped before it compiles anything: that it set about building again is the point.
            const again = serverBuild("linux-x64", { signal: AbortSignal.abort() });
            if (guiAvailable()) await expect(again).rejects.toThrow("Stopped.");
            else expect(await again).toMatchObject({ id, gui: false });
        } finally {
            if (before === undefined) delete process.env.CAVVY_BUILD;
            else process.env.CAVVY_BUILD = before;
        }
    });

    test("this build is named for its commit, and the server's Bun is the one the desktop app and CI use", () => {
        expect(thisBuild()).toMatch(/^[0-9a-f]{12}(-[0-9a-f]{8})?$/);
        const root = join(import.meta.dir, "..");
        expect(readFileSync(join(root, "desktop-electron", "pack.ts"), "utf-8")).toContain(`const SERVER_BUN = "${SERVER_BUN}";`);
        expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8")).toContain(`BUN_VERSION: ${SERVER_BUN}`);
    });
});

describe("what a server is", () => {
    const facts = (over: string) => parseFacts(`os=Linux\narch=x86_64\nhome=/home/dev\nuser=dev\nshell=/bin/bash\nlibc=glibc 2.39\navx2=1\nsystemd=1\nlinger=no\nmem=1905\ndisk=57000\nbuild=aaaaaaaaaaaa\ngui=aaaaaaaaaaaa\nbuild=../../etc\ncurrent=aaaaaaaaaaaa\n${over}`);

    test("read from what it printed; a build's name that isn't one is dropped", () => {
        expect(facts("")).toEqual({ os: "Linux", arch: "x86_64", libc: "glibc 2.39", home: "/home/dev", user: "dev", shell: "/bin/bash", avx2: true, systemd: true, linger: false, memMb: 1905, diskFreeMb: 57000, builds: ["aaaaaaaaaaaa"], guiBuilds: ["aaaaaaaaaaaa"], current: "aaaaaaaaaaaa" });
    });

    test("the build that runs there, or why none does", () => {
        const f = (lines: string) => parseFacts(lines);
        expect(targetFor(f("os=Linux\narch=x86_64\nhome=/h\nlibc=glibc 2.39\navx2=1"), entry)).toBe("linux-x64");
        expect(targetFor(f("os=Linux\narch=x86_64\nhome=/h\nlibc=glibc 2.31"), entry)).toBe("linux-x64-baseline");
        expect(targetFor(f("os=Linux\narch=aarch64\nhome=/h\nlibc=glibc 2.39"), entry)).toBe("linux-arm64");
        expect(() => targetFor(f("os=FreeBSD\narch=amd64\nhome=/h\nlibc=unknown"), entry)).toThrow("Cavvy can't run on box.example: it needs Linux, and this is FreeBSD.");
        expect(() => targetFor(f("os=Linux\narch=armv7l\nhome=/h\nlibc=glibc 2.39"), entry)).toThrow("it needs an x64 or arm64 processor, and this is armv7l.");
        expect(() => targetFor(f("os=Linux\narch=x86_64\nhome=/h\nlibc=musl"), entry)).toThrow("it needs glibc, and this system uses musl (Alpine).");
        // Room is asked about only when a build will be copied: a server that's short of it can still be looked at.
        expect(targetFor(f("os=Linux\narch=x86_64\nhome=/h\nlibc=glibc 2.39\navx2=1\ndisk=120"), entry)).toBe("linux-x64");
        expect(() => checkRoom(f("os=Linux\nhome=/h\ndisk=120"), entry)).toThrow("There isn't room on box.example for Cavvy: it needs 400 MB free, and there are 120.");
        expect(() => checkRoom(f("os=Linux\nhome=/h\ndisk=4000"), entry)).not.toThrow();
    });

    test("its service asks Cavvy alone to stop, outlives a command killed for memory, and gives up on a crash loop", () => {
        expect(UNIT).toContain("ExecStart=%h/.cavvy/server/current/cavvy host run --login-env");
        for (const line of ["Restart=on-failure", "KillMode=mixed", "TimeoutStopSec=30", "OOMPolicy=continue", "StartLimitBurst=5", "Environment=CAVVY_NO_KEYCHAIN=1", "WantedBy=default.target"]) expect(UNIT.split("\n")).toContain(line);
    });
});

describe("signing a machine in", () => {
    const M = "0123456789abcdef0123456789abcdef";
    const N = "fedcba9876543210fedcba9876543210";

    test("a code works once, within two minutes; a token for twelve hours", () => {
        let now = 1_000_000;
        const s = new MachineSignIns(() => now);
        const code = s.pair(M);
        const token = s.redeem(code)!;
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(s.redeem(code)).toBeUndefined();
        expect(s.check(token)).toEqual({ machine: M, client: undefined });
        expect(s.check("0".repeat(64))).toBeUndefined();
        expect(s.check(code)).toBeUndefined();

        const late = s.pair(M);
        now += 120_001;
        expect(s.redeem(late)).toBeUndefined();
        expect(s.check(token)?.machine).toBe(M);
        now += 12 * 3600_000;
        expect(s.check(token)).toBeUndefined();
    });

    test("one of a machine's connections can be signed out alone", () => {
        const s = new MachineSignIns();
        const tab = s.redeem(s.pair(M, "aaaaaaaaaaaaaaaa"))!;
        const other = s.redeem(s.pair(M, "bbbbbbbbbbbbbbbb"))!;
        const plain = s.redeem(s.pair(M))!;
        expect(s.check(tab)).toEqual({ machine: M, client: "aaaaaaaaaaaaaaaa" });
        s.revoke(M, "aaaaaaaaaaaaaaaa");
        expect(s.check(tab)).toBeUndefined();
        expect(s.check(other)?.client).toBe("bbbbbbbbbbbbbbbb");
        expect(s.check(plain)?.machine).toBe(M);
    });

    test("signing one machine out leaves the others in", () => {
        const s = new MachineSignIns();
        const mine = s.redeem(s.pair(M))!;
        const theirs = s.redeem(s.pair(N))!;
        const pending = s.pair(M);
        s.revoke(M);
        expect(s.check(mine)).toBeUndefined();
        expect(s.redeem(pending)).toBeUndefined();
        expect(s.check(theirs)?.machine).toBe(N);
    });

    test("codes nobody uses don't pile up: the oldest go", () => {
        const s = new MachineSignIns();
        const first = s.pair(M);
        const rest = Array.from({ length: 32 }, () => s.pair(M));
        expect(s.redeem(first)).toBeUndefined();
        expect(s.redeem(rest.at(-1)!)).toBeDefined();
    });
});

describe("what the one-time copy carries", () => {
    test("settings that are a way of working go; anything that holds a key, runs a command, or sets the mode stays", () => {
        const out = portableSettings({
            model: "anthropic:claude",
            effort: "high",
            env: { OPENAI_API_KEY: FAKE.openai },
            hooks: { PreToolUse: [{ command: "curl example.com" }] },
            statusLine: { command: "date" },
            permissions: { allow: ["Bash(npm run lint:*)"], deny: ["Read(./secrets/**)"], defaultMode: "bypassPermissions", allowBypass: true, additionalDirectories: ["/Users/me/other"] },
            editor: "code",
            browser: { executable: "/Applications/Chrome.app" },
            enabledPlugins: { x: true },
            mcpServers: {
                docs: { url: "https://mcp.example.com/sse" },
                keyed: { url: "https://mcp.example.com/sse", headers: { Authorization: `Bearer ${FAKE.openai}` } },
                local: { url: "http://localhost:3000/mcp" },
                npx: { command: "npx", args: ["-y", "@example/mcp"] },
                script: { command: "node", args: ["/Users/me/tools/mcp.js"] },
                binary: { command: "/usr/local/bin/my-mcp" },
                env: { command: "npx", args: ["-y", "x"], env: { TOKEN: "t" } },
            },
        } as any);
        expect(out).toEqual({ model: "anthropic:claude", effort: "high", permissions: { allow: ["Bash(npm run lint:*)"], deny: ["Read(./secrets/**)"] }, mcpServers: { docs: { url: "https://mcp.example.com/sse" }, npx: { command: "npx", args: ["-y", "@example/mcp"] } } } as any);
        expect(portableMcpServer({ command: "uvx", args: ["tool", "~/data"] })).toBe(false);
        expect(portableMcpServer({ url: "https://x.example/mcp", oauth: { clientId: "id", clientSecret: "s" } })).toBe(false);
        expect(portableMcpServer({ url: "https://x.example/mcp", oauth: { clientId: "id" } })).toBe(true);
    });

    test("a key written into an MCP server's address or arguments, or into a rule, stays here", () => {
        const out = portableSettings({
            model: "anthropic:claude",
            permissions: { allow: ["Bash(npm test:*)", `Bash(curl -H "Authorization: Bearer ${FAKE.openai}" https://api.example.com:*)`] },
            mcpServers: {
                fine: { url: "https://mcp.example.com/sse" },
                query: { url: "https://mcp.example.com/sse?api_key=abc123" },
                userinfo: { url: "https://user:hunter2@mcp.example.com/sse" },
                keyArg: { command: "npx", args: ["-y", "some-mcp", "--api-key", "abc123"] },
                keyEquals: { command: "npx", args: ["-y", "some-mcp", "--token=abc123"] },
                keyShaped: { command: "npx", args: ["-y", "some-mcp", FAKE.anthropic] },
                header: { command: "npx", args: ["-y", "mcp-remote", "https://x.example/mcp", "--header", "X-Key: abc"] },
                // Reachable only from this machine or its network.
                lan: { url: "http://192.168.1.10:8080/mcp" },
                any: { url: "http://0.0.0.0:8080/mcp" },
                bonjour: { url: "http://printer.local/mcp" },
                bare: { url: "http://devbox:3000/mcp" },
            },
        } as any);
        expect(out).toEqual({ model: "anthropic:claude", permissions: { allow: ["Bash(npm test:*)"] }, mcpServers: { fine: { url: "https://mcp.example.com/sse" } } } as any);
        expect(JSON.stringify(out)).not.toMatch(/abc123|hunter2|Bearer|sk-/);
    });

    test("only what can't be holding a key goes: a key needn't look like one, so nothing is searched for one", () => {
        // An MCP server is copied for being a plain public address, or one package to run. These are neither.
        for (const c of [
            { url: "https://mcp.zapier.com/api/mcp/s/Zx81kq0TtR7vLm2Qp9aB/mcp" },
            { url: "https://mcp.pipedream.net/3f2a9c1e-77b4-4e0d-9a51-0c2d6e8f1a23/github" },
            { url: "https://mcp.example.com/sse#token=abc123" },
            { command: "npx", args: ["mcp-remote", "https://user:hunter2@mcp.example.com/sse"] },
            { command: "npx", args: ["-y", "some-mcp", "-k", "abc123secret"] },
            { command: "npx", args: ["-y", "some-mcp", "hunter2"] },
            { command: "docker", args: ["run", "-i", "-e", "TOKEN", "ghcr.io/example/mcp"] },
            { command: "npx", args: [] },
            { command: "sh", args: ["-c", "TOKEN=abc npx some-mcp"] },
            // A program of this machine's, or a file on it.
            { command: "node", args: ["server.js"] },
            { command: "my-mcp", args: ["serve"] },
            { command: "pnpm", args: ["some-mcp"] },
        ]) expect(portableMcpServer(c as any)).toBe(false);
        for (const c of [
            { url: "https://mcp.example.com/sse" },
            { url: "https://fetch.example.com/mcp" },
            { url: "wss://api.example.org/v1/mcp" },
            { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
            { command: "uvx", args: ["mcp-server-git"] },
            { command: "bunx", args: ["some-mcp@1.2.3"] },
            { command: "pnpm", args: ["dlx", "some-mcp"] },
            { command: "pipx", args: ["run", "mcp-server-fetch"] },
        ]) expect(portableMcpServer(c as any)).toBe(true);

        // A rule is copied for being plain words: no options, assignments, addresses or quotes, where a key would sit.
        for (const r of ['Bash(curl -H "Authorization: Bearer abc123def456ghi789jkl" https://api.example.com/v1:*)', "Bash(curl -u admin:hunter2 https://ci.example.com:*)", "Bash(PGPASSWORD=hunter2 psql -h db:*)", "Bash(mysql -pS3cret:*)", "Bash(ssh admin@host:*)", "WebFetch(https://user:pw@example.com)", "not a rule("]) expect(portableRule(r)).toBe(false);
        for (const r of ["Edit", "Bash(npm run lint:*)", "Bash(git push origin main:*)", "Read(./secrets/**)", "Read(~/notes/*.md)", "WebFetch(domain:example.com)", "mcp__docs__search"]) expect(portableRule(r)).toBe(true);

        // An address needs no scheme to carry a token, in its path or in its name; nor does a rule need one.
        for (const r of ["Bash(curl hooks.slack.com/services/T0AB12CD3/B0EF45GH6/Zx81kq0TtR7vLm2Qp9aBcdEf:*)", "WebFetch(domain:Zx81kq0TtR7vLm2Qp9aB.example.com)"]) expect(portableRule(r)).toBe(false);
        expect(portableMcpServer({ url: "https://zx81kq0ttr7vlm2qp9ab.mcp.example.com/sse" })).toBe(false);
        for (const r of ["Bash(bun test ./test/foo.test.ts:*)", "Bash(python3 -m)", "WebFetch(domain:docs.example.com)", "Bash(date +2026-01-15:*)"].filter((r) => !r.includes(" -") && !r.includes("+"))) expect(portableRule(r)).toBe(true);

        // Reachable only from this machine or its network, however the address is written.
        for (const url of ["http://[::ffff:127.0.0.1]/mcp", "http://[::1]:8080/mcp", "http://100.101.102.103/mcp", "https://db.internal/mcp", "https://nas.lan/mcp", "https://box.home.arpa/mcp"]) expect(portableMcpServer({ url })).toBe(false);
        expect(portableMcpServer({ url: "https://100.example.com/mcp" })).toBe(true);

        // Settings written some other way aren't portable, and don't stop the copy.
        expect(portableMcpServer({ command: "npx", args: "-y some-mcp" } as any)).toBe(false);
        expect(portableMcpServer({ url: 42 } as any)).toBe(false);

        // What goes is the entry made again from what was checked, never the entry as it was: a field of some other
        // tool's, with a key in it, has nowhere to ride.
        const carried = portableSettings({
            mcpServers: {
                docs: { type: "http", url: "https://mcp.example.com/mcp", apiKey: "Zx81kq0TtR7vLm2Qp9aB", headersHelper: "/usr/local/bin/get-token", oauth: { clientId: "cavvy-desktop", scopes: ["read"], client_secret: "Zx81kq0TtR7vLm2Qp9aB" } },
                mem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], envFile: "/Users/me/.env", disabled: true },
            },
        } as any);
        expect(carried).toEqual({ mcpServers: { docs: { type: "http", url: "https://mcp.example.com/mcp", oauth: { clientId: "cavvy-desktop", scopes: ["read"] } }, mem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], disabled: true } } } as any);

        // What stays is counted, so the user is told.
        const left = { servers: [] as string[], rules: 0 };
        portableSettings({ permissions: { allow: ["Edit", "Bash(curl -u admin:hunter2 https://ci.example.com:*)"], deny: ["Bash(PGPASSWORD=x psql:*)"] }, mcpServers: { docs: { url: "https://mcp.example.com/sse" }, zap: { url: "https://mcp.zapier.com/api/mcp/s/Zx81kq0TtR7vLm2Qp9aB/mcp" }, local: { command: "node", args: ["server.js"] } } } as any, left);
        expect(left).toEqual({ servers: ["zap", "local"], rules: 2 });
        expect(describeLeft(left)).toBe("2 MCP servers and 2 permission rules");
        expect(describeLeft({ servers: ["x"], rules: 0 })).toBe("1 MCP server");
        expect(describeLeft({ servers: [], rules: 0 })).toBe("");
    });

    test("a token of letters and digits at random isn't taken for a name, in an address or in a rule; the names commands are made of are", () => {
        // A fixed sequence, so every run measures the same tokens.
        let seed = 0x9e3779b9;
        const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0), ((seed ^ (seed >>> 13)) >>> 0) / 2 ** 32);
        const alphabets = {
            base62: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
            base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
            base36: "abcdefghijklmnopqrstuvwxyz0123456789",
            base32: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
            hex: "0123456789abcdef",
            letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
            lower: "abcdefghijklmnopqrstuvwxyz",
        };
        const tries = 1500;
        const copied: Record<string, number> = {};
        for (const [name, alphabet] of Object.entries(alphabets)) {
            for (const length of [16, 20, 24, 32, 40]) {
                let n = 0;
                for (let i = 0; i < tries; i++) {
                    let token = "";
                    for (let j = 0; j < length; j++) token += alphabet[Math.floor(rnd() * alphabet.length)];
                    if (portableMcpServer({ url: `https://mcp.example.com/s/${token}/mcp` })) n++;
                    if (portableRule(`Bash(curl hooks.example.com/services/${token}:*)`)) n++;
                }
                if (n) copied[`${name} ${length}`] = n;
            }
        }
        // Of 3000 tries each: none, but for the shortest tokens of the one alphabet that has dashes in it, which now
        // and then cut a token into pieces that each read as a name. (Measured: 41 and 13. Before, about 2000.)
        expect(Object.keys(copied).sort()).toEqual(["base64url 16", "base64url 20"]);
        expect(copied["base64url 16"]).toBeLessThan(60);
        expect(copied["base64url 20"]).toBeLessThan(30);
        // The ones a reviewer got through, and keys written in groups.
        for (const token of ["QhVxKbTmWzRpLsNdYfGjCk7a", "QhVx-KbTm-WzRp-LsNd", "abc12-def34-ghi56-jkl78", "T0AB12CD3", "Zx81kq0TtR7vLm2Qp9aBcdEf"]) {
            expect([token, portableMcpServer({ url: `https://mcp.example.com/s/${token}/mcp` }), portableRule(`Bash(curl hooks.example.com/services/${token}:*)`)]).toEqual([token, false, false]);
        }

        // What it mustn't cost: the names tools, files, versions and addresses really have.
        const names = ["npm", "typecheck", "x86_64-linux-gnu-gcc", "python3.12", "k8s", "e2e", "i18n", "s3cmd", "md5sum", "sha256sum", "AppIcon1024.png", "MyApp", "iOS", "README.md", "release-2024", "node_modules", "eslint-plugin-react-hooks", "v1.2.3", "MyProject.xcodeproj", "gpt-4o", "oauth2", "x264", "JSONSchema", "getUserById", "HTTPServer", "assembleDebug", "next.config.js", "package-lock.json", "ubuntu-24.04", "arm64-v8a", "ES2022", "XMLHttpRequest", "iPhone15", "1.2.3-beta.4", "2024-01-31", "sha256-md5"];
        expect(names.filter((name) => !portableRule(`Bash(tool ${name}:*)`))).toEqual([]);
        const rules = ["Bash", "mcp__docs__search", "Bash(npm run lint:*)", "Bash(bun test ./test/foo.test.ts)", "Read(./secrets/**)", "Read(~/.zshrc)", "WebFetch(domain:docs.example.com)", "Edit(src/**/*.ts)", "Bash(python3 manage.py migrate:*)"];
        expect(rules.filter((rule) => !portableRule(rule))).toEqual([]);
        const addresses = ["https://mcp.example.com/mcp", "https://mcp.linear.app/sse", "https://api.githubcopilot.com/mcp/", "https://mcp.1password.com/v1", "https://docs.example.com", "wss://mcp.example.com/ws"];
        expect(addresses.filter((url) => !portableMcpServer({ url }))).toEqual([]);
    });

    test("an address goes as it was judged, not as it was typed", () => {
        // Written to come out as another path than the one that reads: what's copied is what it comes to.
        expect(portableMcpEntry({ url: "https://mcp.example.com/a/../Zx81kq0TtR7vLm2Qp9aBcdEf/../mcp" })).toEqual({ url: "https://mcp.example.com/mcp" });
        expect(portableMcpEntry({ url: "https://MCP.Example.com/mcp/" })).toEqual({ url: "https://mcp.example.com/mcp/" });
        // A bare host stays bare.
        expect(portableMcpEntry({ url: "https://docs.example.com" })).toEqual({ url: "https://docs.example.com" });
    });

    test("memory, skills and commands go; keys, and files that read like they hold one, stay", () => {
        const claude = process.env.CLAUDE_CONFIG_DIR!;
        const codex = process.env.CODEX_HOME!;
        const put = (file: string, body: string) => (mkdirSync(join(file, ".."), { recursive: true }), writeFileSync(file, body));
        put(join(iso.home, "CAVVY.md"), "Prefer small commits.\n");
        put(join(iso.home, "credentials.json"), JSON.stringify({ openai: FAKE.openai }));
        put(join(iso.home, "commands", "ship.md"), "Ship it.\n");
        put(join(iso.home, "commands", "leaky.md"), `Use ${FAKE.anthropic} for this.\n`);
        put(join(iso.home, "skills", "review", "SKILL.md"), "---\nname: review\n---\nReview.\n");
        put(join(iso.home, "skills", "review", "run.sh"), "#!/bin/sh\necho ok\n");
        chmodSync(join(iso.home, "skills", "review", "run.sh"), 0o755);
        put(join(iso.home, "skills", "review", ".env"), "TOKEN=abc\n");
        put(join(iso.home, "skills", "review", "node_modules", "dep", "index.js"), "x\n");
        put(join(claude, "CLAUDE.md"), "Be brief.\n");
        put(join(claude, ".credentials.json"), "{}");
        put(join(claude, "skills", "notes", "SKILL.md"), "---\nname: notes\n---\nNotes.\n");
        put(join(codex, "AGENTS.md"), "Run the tests.\n");
        put(join(codex, "auth.json"), "{}");
        // A skill kept somewhere else and linked in is the user's own; a link inside one could point anywhere.
        const elsewhere = tempDir("cavvy-servers-skill-");
        put(join(elsewhere, "SKILL.md"), "---\nname: linked\n---\nLinked.\n");
        symlinkSync(elsewhere, join(iso.home, "skills", "linked"));
        symlinkSync("/etc/hosts", join(iso.home, "skills", "review", "hosts"));
        // A memory file and a command kept in a dotfiles folder and linked in: they go as the files they are.
        const dotfiles = tempDir("cavvy-servers-dotfiles-");
        put(join(dotfiles, "rule.md"), "Tabs, not spaces.\n");
        mkdirSync(join(claude, "rules"), { recursive: true });
        symlinkSync(join(dotfiles, "rule.md"), join(claude, "rules", "style.md"));
        put(join(dotfiles, "deploy.md"), "Deploy it.\n");
        symlinkSync(join(dotfiles, "deploy.md"), join(iso.home, "commands", "deploy.md"));

        const plan = planCopy({ model: "anthropic:claude", env: { X: "y" } } as any);
        try {
            const files = (Bun.spawnSync(["find", ".", "-type", "f"], { cwd: plan.stage }).stdout.toString().trim().split("\n")).map((f) => f.slice(2)).sort();
            expect(files).toEqual([".cavvy/CAVVY.md", ".cavvy/commands/deploy.md", ".cavvy/commands/ship.md", ".cavvy/settings.json", ".cavvy/skills/linked/SKILL.md", ".cavvy/skills/review/SKILL.md", ".cavvy/skills/review/run.sh", ".claude/CLAUDE.md", ".claude/rules/style.md", ".claude/skills/notes/SKILL.md", ".codex/AGENTS.md"]);
            // Real files with what the links name in them, not links to this machine's paths (find -type f above saw them).
            expect(readFileSync(join(plan.stage, ".claude", "rules", "style.md"), "utf-8")).toBe("Tabs, not spaces.\n");
            expect(lstatSync(join(plan.stage, ".cavvy", "commands", "deploy.md")).isSymbolicLink()).toBe(false);
            expect(lstatSync(join(plan.stage, ".cavvy", "skills", "review", "run.sh")).mode & 0o100).toBe(0o100);
            expect(JSON.parse(readFileSync(join(plan.stage, ".cavvy", "settings.json"), "utf-8"))).toEqual({ model: "anthropic:claude" });
            expect(plan.counts).toEqual({ settings: true, memory: 4, skills: 3, commands: 2 });
            expect(describeCopy(plan.counts)).toBe("settings, memory, 3 skills and 2 commands");
            // What a server took is counted the same way, from the files it names.
            expect(countCopied(files)).toEqual(plan.counts);
            expect(describeCopy(countCopied([".cavvy/commands/ship.md"]))).toBe("1 command");
            expect(describeCopy(countCopied([]))).toBe("");
        } finally {
            plan.cleanup();
        }
        expect(existsSync(plan.stage)).toBe(false);
        expect(describeCopy({ settings: false, memory: 0, skills: 0, commands: 0 })).toBe("");
        expect(describeCopy({ settings: true, memory: 0, skills: 0, commands: 0 })).toBe("settings");
    });
});

describe("what the terminal says", () => {
    const all = { clis: [{ id: "claude-code", product: "Claude Code", installed: true, signedIn: true, install: "Install Claude Code (https://code.claude.com/docs/en/setup)", signIn: "claude auth login" }, { id: "codex", product: "Codex", installed: false, install: "Install the Codex CLI (npm install -g @openai/codex)", signIn: "codex login" }], git: true, gh: { installed: true, signedIn: true }, browser: true, memMb: 2000 };

    test("a server with everything says nothing; each thing missing is one line the user can act on", () => {
        expect(checkLines(all, { service: true })).toEqual([]);
        expect(checkLines({ ...all, clis: all.clis.map((c) => ({ ...c, installed: false })), gh: { installed: false }, browser: false, git: false }, { service: false, lingerFix: "sudo loginctl enable-linger dev" })).toEqual([
            "It won't start Cavvy again after a reboot. To fix that, run on it: sudo loginctl enable-linger dev",
            "No agent CLI is installed there (Claude Code, Codex). Models with an API key work without one.",
            "  Install Claude Code (https://code.claude.com/docs/en/setup)",
            "  Install the Codex CLI (npm install -g @openai/codex)",
            "git isn't installed there.",
            "The GitHub CLI isn't installed there: pull requests need it.",
            "No Chrome there: the Browser tool needs one.",
        ]);
        expect(checkLines({ ...all, clis: [{ ...all.clis[0]!, signedIn: false }], gh: { installed: true, signedIn: false } })).toEqual(["Claude Code isn't signed in there. On it: claude auth login", "The GitHub CLI isn't signed in there. On it: gh auth login"]);
    });

    test("a server's name may carry the folder to work in", () => {
        expect(parseServerSpec("box")).toEqual({ name: "box", folder: "~" });
        expect(parseServerSpec("box:~/code/app")).toEqual({ name: "box", folder: "~/code/app" });
        expect(parseServerSpec("box:/srv/app:2")).toEqual({ name: "box", folder: "/srv/app:2" });
        expect(parseServerSpec("box:")).toEqual({ name: "box", folder: "~" });
    });
});
