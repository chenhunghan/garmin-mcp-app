# Garmin MCP App

MCP App server with interactive React UI for Garmin Connect integration.

## Getting Started

```bash
git clone https://github.com/chenhunghan/garmin-mcp-app.git
cd garmin-mcp-app
npm install
```

`npm install` automatically sets up git hooks via [prek](https://github.com/j178/prek):

- **commit-msg** — enforces [Conventional Commits](https://www.conventionalcommits.org/) via commitlint
- **pre-push** — runs lint, format check, typecheck, and tests (same as CI)

### Troubleshooting: `core.hooksPath`

If `npm install` warns about `core.hooksPath`, prek cannot install git hooks. Fix it by unsetting the local config:

```bash
git config --unset-all --local core.hooksPath
npm run prepare
```

## Testing in Claude Desktop

Run `npm run build` (one-off) or `npm run dev` (watch mode for live rebuilds), then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-mcp-app/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. Ask Claude to check your Garmin auth — it will render the app UI in an iframe and run the real login/MFA flow.

## Development

```bash
npm run dev        # watch-build server + UI
npm run dev:ui     # standalone UI dev at localhost:5173
npm run test:lib   # run garmin-connect tests
npm run pack       # build + package .mcpb bundle
```

`npm run dev:ui` opens `http://localhost:5173` with the React UI wired to the real MCP server in-process. You can test login, MFA, and logout against the actual Garmin API without deploying to Claude Desktop.

## Commit Convention

Commits must follow the Conventional Commits format:

```
type(optional-scope): description
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, `test`
