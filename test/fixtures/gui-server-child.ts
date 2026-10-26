// A GUI server in a process of its own, so a test can kill it outright (as
// a crash or SIGKILL would) and see what a session keeps of a turn cut off
// part way. It uses the environment it's started with (CAVVY_HOME and the
// rest, from isolate()), takes its token from CHILD_TOKEN, and prints
// {"port": n} once it's listening.

const { startServer } = await import("../../src/server/server");
const srv = await startServer({ token: process.env.CHILD_TOKEN ?? "" });
process.stdout.write(JSON.stringify({ port: srv.port }) + "\n");
