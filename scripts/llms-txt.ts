/**
 * Print merrymen.dev's llms.txt (the production setup instructions an AI
 * assistant follows) to stdout:
 *
 *   node_modules/.bin/tsx scripts/llms-txt.ts > site/public/llms.txt
 *
 * Run it from a POSIX shell (Git Bash on Windows): PowerShell 5.1's `>` writes
 * UTF-16. web/src/mcp/assistant-setup.test.ts fails when the committed file
 * and this output differ, so the static copy cannot drift from the app's
 * /llms.txt.
 */
import { llmsTxt } from "../web/src/mcp/assistant-setup";
import { PLUGIN_SERVER_URL } from "../web/src/mcp/install-links";

process.stdout.write(llmsTxt({ server: PLUGIN_SERVER_URL, app: "https://app.merrymen.dev" }));
