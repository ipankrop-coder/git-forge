# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ipankrop-coder/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ipankrop-coder/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01): git smart HTTP
(protocol v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP over
streamable HTTP, in one Node 22 process with no dependencies.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the harness at
`$MAKEFUN_ENV_URL`, serves until the harness says done, and exits 0. The
bearer token for every API call is `$MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll `/done`).
- `app.ts` — the HTTP server: routing, auth, body reading.
- `src/store.ts` — the in-memory store: repos, refs, objects, issues, PRs.
- `src/gitproto.ts` — pkt-line framing, packfiles, upload-pack v2, receive-pack v0.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL v4: parser, executor, schema.
- `src/mcp.ts` — MCP (JSON-RPC 2.0, revision 2026-07-28) tools.
