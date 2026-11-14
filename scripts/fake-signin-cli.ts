// A pretend CLI with every kind of sign-in, for the sign-in tests and the GUI
// demo: `acme` on a PATH of its own, keeping whether it's signed in (and as
// whom) in a file. ACME_SERVICE gives it a state of its own (several pretend
// services from one script); ACME_AUTO=<seconds> finishes a waiting sign-in by
// itself after that long, as if the web page had been completed.
//
//   acme status                 "Logged in as <who>" (0) or "Not logged in. Run: acme login" (1)
//   acme login --device         prints a code and a link, then waits for `approve()`
//   acme login --paste          prints a link, asks for the code at a prompt, accepts "good-code"
//   acme login --browser        prints a link and waits for `approve()`
//   acme login --typed          asks Username: and Password: (not echoed), accepts password "hunter22"
//   acme login --token          reads a token from its input, accepts "good-token-123"
//   acme setup                  leaves a file, to show it ran
//
// This module must not import anything from src (tests load it before their isolation).

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const SCRIPT = `#!/bin/sh
state="$ACME_HOME/state\${ACME_SERVICE:+-$ACME_SERVICE}"
auto=\${ACME_AUTO:+$((ACME_AUTO * 20))}
waited() { [ -e "$ACME_HOME/approve" ] && return 0; [ -n "$auto" ] && [ "$1" -ge "$auto" ] && { printf 'me@example.com' > "$ACME_HOME/approve.auto"; return 0; }; return 1; }
who() { cat "$ACME_HOME/approve" 2>/dev/null || cat "$ACME_HOME/approve.auto"; }
signed() { printf '%s\\n' "$1" > "$state"; }
case "$1 $2" in
"status ")
    if [ -s "$state" ]; then echo "Logged in as $(cat "$state")"; exit 0; fi
    echo "Not logged in. Run: acme login"; exit 1 ;;
"login --device")
    printf '\\033[1m! First copy your one-time code: \\033[0mWXYZ-1234\\n'
    echo "Open this URL to continue in your web browser: https://acme.example/device"
    [ -n "$BROWSER" ] && echo "browser=$BROWSER" >> "$ACME_HOME/log"
    i=0
    while ! waited $i; do
        [ -e "$ACME_HOME/expire" ] && { echo "error: the code expired"; exit 1; }
        [ -e "$ACME_HOME/refuse" ] && { echo "error: access was denied"; exit 1; }
        sleep 0.05; i=$((i+1)); [ $i -gt 12000 ] && exit 1
    done
    signed "$(who)"; echo "Authentication complete."; exit 0 ;;
"login --browser")
    echo "Opening your browser. If it doesn't open, visit:"
    echo "https://acme.example/authorize?state=abc"
    echo "browser=\${BROWSER:-default}" >> "$ACME_HOME/log"
    i=0
    while ! waited $i; do sleep 0.05; i=$((i+1)); [ $i -gt 12000 ] && exit 1; done
    signed "$(who)"; exit 0 ;;
"login --paste")
    echo "Visit: https://acme.example/authorize?mode=paste"
    printf 'Paste the code here > '
    read -r code
    if [ "$code" = "good-code" ]; then signed "pasted@example.com"; echo "Done."; exit 0; fi
    echo "error: that code is not valid"; exit 1 ;;
"login --typed")
    printf 'Username: '
    read -r user
    stty -echo 2>/dev/null
    printf 'Password: '
    read -r pass
    stty echo 2>/dev/null
    echo
    if [ "$pass" = "hunter22" ]; then signed "$user"; echo "Login Succeeded"; exit 0; fi
    echo "Error: unauthorized: incorrect username or password"; exit 1 ;;
"login --token")
    read -r token
    if [ "$token" = "good-token-123" ]; then signed "token-user"; exit 0; fi
    echo "error validating token $token: HTTP 401: Bad credentials"; exit 1 ;;
"setup ")
    echo ran > "$ACME_HOME/setup"; exit 0 ;;
esac
echo "unknown: $*"; exit 2
`;

export interface FakeSignInCli {
    /** The folder to put first on PATH. */
    bin: string;
    home: string;
    /** The web page was completed: the waiting sign-in finishes, as `who`. */
    approve(who?: string): void;
    /** The waiting device sign-in ends: its code expired, or was refused. */
    expire(): void;
    refuse(): void;
    /** Signed in some other way (the user's own terminal). */
    signIn(who: string): void;
    signOut(): void;
    signedIn(): string | undefined;
    /** What its sign-ins noted (which BROWSER they were given). */
    log(): string;
    ranSetup(): boolean;
    reset(): void;
}

export function fakeSignInCli(dir: string): FakeSignInCli {
    const bin = join(dir, "bin");
    const home = join(dir, "acme-home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(bin, "acme"), SCRIPT);
    chmodSync(join(bin, "acme"), 0o755);
    process.env.ACME_HOME = home;
    const f = (name: string) => join(home, name);
    const reset = () => {
        // Every pretend service's state (state-<service>), and what the tests left to steer a sign-in.
        for (const n of readdirSync(home)) if (n.startsWith("state") || ["approve", "approve.auto", "expire", "refuse", "log", "setup"].includes(n)) rmSync(f(n), { force: true });
    };
    return {
        bin,
        home,
        approve: (who = "me@example.com") => writeFileSync(f("approve"), who),
        expire: () => writeFileSync(f("expire"), ""),
        refuse: () => writeFileSync(f("refuse"), ""),
        signIn: (who) => writeFileSync(f("state"), `${who}\n`),
        signOut: () => rmSync(f("state"), { force: true }),
        signedIn: () => (existsSync(f("state")) ? readFileSync(f("state"), "utf8").trim() || undefined : undefined),
        log: () => (existsSync(f("log")) ? readFileSync(f("log"), "utf8") : ""),
        ranSetup: () => existsSync(f("setup")),
        reset,
    };
}

/** Recipes for `acme`, one per kind of sign-in. */
export const ACME = {
    status: { run: "acme status", who: "Logged in as (\\S+)" },
    reads: { code: "\\b([A-Z0-9]{4}-[A-Z0-9]{4})\\b", url: "(https://acme\\.example/\\S+)", prompt: "Paste the code", expired: "expired" },
    signedOut: ["Not logged in\\. Run: acme login"],
};

export function acmeRecipe(flow: "device" | "browser" | "paste" | "typed" | "token", extra: Record<string, unknown> = {}) {
    return {
        id: "acme",
        name: "Acme",
        status: ACME.status,
        here: { flow, run: `acme login --${flow}` },
        reads: ACME.reads,
        signedOut: ACME.signedOut,
        ...extra,
    };
}
