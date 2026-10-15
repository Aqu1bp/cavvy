// Opens the session file given (which claims it), says so, and keeps it open until stdin closes.
const { Session } = await import("../../src/agent/session");
Session.load(process.argv[2]!);
process.stdout.write("held\n");
for await (const _ of process.stdin) {
    // waiting
}
