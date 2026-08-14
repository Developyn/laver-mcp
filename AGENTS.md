# AGENTS.md — @laver/mcp

MCP server for [Laver](https://laver.app). Every tool is a thin call to the public REST API at `https://api.laver.app`; there is no local state and no second implementation of anything. See `README.md` for the tool list and setup.

This repository mirrors what is published to npm as `@laver/mcp`. `server.js`, `README.md` and `LICENSE` are the published files (see `files` in `package.json`); anything else here is repo-only and does not ship.

## Development

Source of truth for the server is the private Laver monorepo at `mcp/`. Changes land there, are published to npm, and are mirrored here — do not fix a bug only in this repo, or the next publish reverts it.

| Command | Purpose |
|---|---|
| `npm run check` | Full check suite against a stub API |
| `npm run check:live` | Same suite against the live API (needs `LAVER_API_KEY`) |
| `npm start` | Run the server on stdio |

Node 24 is the floor in `engines`.

The `Dockerfile` is repo-only and is not published to npm. It exists because directory listings (Glama) build the server and probe it. Build and probe it the same way they do:

```bash
docker build -t laver-mcp .
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | docker run -i --rm laver-mcp
```

That must return all tools **without** `LAVER_API_KEY` set — the key is only needed once a tool actually calls the API. A server that refused to start without credentials would fail the listing checks.

## Git rules

- Commit only when explicitly asked, and stage only intended files.
- No AI attribution anywhere in the repo's public record: no `Co-Authored-By` trailer naming an assistant, no "Generated with" footer in commit messages, PR titles or PR bodies, and no assistant named as an author. The commit is authored by the person who asked for it.
- Naming Claude, Cursor or any other client in *documentation* is unrelated to the above and stays — this server supports them and the README says so.
- Never amend, force-push or reset hard unless explicitly requested.
