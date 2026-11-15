// Cavvy's own MCP server's name, as agent CLIs see it (mcp__<name>__<tool>). In a module of its own, with nothing to
// load first: modules that delegation.ts loads need it before delegation.ts has run.
import { APP_NAME } from "../config/name";

export const MCP_SERVER_NAME = APP_NAME;
