// Opens the session file given (which claims it), says so ("held", or "in_use"
// if another process has it), and keeps it open until stdin closes.
const { Session, SessionInUseError } = await import("../../src/agent/session");
try {
    Session.load(process.argv[2]!);
} catch (e) {
    if (!(e instanceof SessionInUseError)) throw e;
    process.stdout.write("in_use\n");
    process.exit(0);
}
process.stdout.write("held\n");
for await (const _ of process.stdin) {
    // waiting
}
