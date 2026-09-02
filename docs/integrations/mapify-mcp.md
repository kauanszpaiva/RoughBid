# Mapify MCP

RoughBid includes a local Model Context Protocol (MCP) server that keeps Mapify
credentials on the server while exposing building measurements and blueprints to MCP
clients. The checked-in `.mcp.json` starts the server over stdio with Node.js.

## Configuration

1. Obtain a Mapify server API key and the HTTPS API base URL for your account.
2. Copy `.env.example` to a local, untracked `.env` and set:

   ```sh
   MAPIFY_API_KEY=your-server-key
   MAPIFY_API_BASE_URL=https://your-mapify-api.example
   ```

3. Export those variables in the environment that launches your MCP client. Restart
   the client so it discovers `.mcp.json`. Never place the API key in `.mcp.json` or
   expose it through a `NEXT_PUBLIC_` variable.

The server supports the MCP `initialize`, `ping`, `tools/list`, and `tools/call`
methods over newline-delimited JSON-RPC on stdin/stdout. It offers:

| Tool | Purpose |
| --- | --- |
| `mapify_measure_building` | Starts a real-time measurement job for a postal address |
| `mapify_get_job` | Polls the latest state/result of a measurement or blueprint job |
| `mapify_get_blueprint` | Retrieves a building blueprint as PDF, SVG, or DXF |

Mapify calls time out after 30 seconds. The asynchronous job tool should be used for
longer processing, rather than leaving an MCP request open. Production endpoints must
use HTTPS; plain HTTP is accepted only for local development.
