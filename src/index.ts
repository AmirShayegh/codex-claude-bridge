// No args = MCP server (Claude Code integration). Any arg = CLI mode.
const isCli = process.argv.length > 2;

if (isCli) {
  import('./cli/commands.js').then(({ runCli }) => runCli()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  import('./mcp.js').then(({ startMcpServer }) => startMcpServer()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
