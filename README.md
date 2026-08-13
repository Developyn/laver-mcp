# @laver/mcp

An MCP server for [Laver](https://laver.app). Gives an agent tools to read and
drive kanban boards, tickets and the workspace wiki.

Every tool is a thin call to the same public REST API the web app uses. There is
no local state, no cache, and no second implementation of anything — if Laver
refuses a write, the refusal comes back verbatim, because an agent can act on
"409, re-read and retry" and cannot act on "something went wrong".

## Setup

Create a workspace-scoped API key in Laver under **Admin → API keys**. It acts
as the person who created it, so it can do exactly what they can do and nothing
more, and it can be revoked without touching their account.

```json
{
  "mcpServers": {
    "laver": {
      "command": "npx",
      "args": ["-y", "@laver/mcp"],
      "env": { "LAVER_API_KEY": "your key here" }
    }
  }
}
```

`LAVER_API_URL` overrides the API host; it defaults to `https://api.laver.app`.
`LAVER_API_KEY_FILE` is an alternative to `LAVER_API_KEY`: a path to either a
file containing nothing but the key, or a `.env`-style file with a
`LAVER_API_KEY=…` line among others (an assignment line wins; quotes and an
`export` prefix are both fine). That is how the `.mcp.json` in this repo
registers the server without a secret in a tracked file.

A file with neither — no assignment line, and more than one token in it — yields
**no key at all**, and you get the "key is not set" error. It used to send the
whole file as the token, which is fine for a file holding one secret and is a
leak for anything else.

`LAVER_API_URL` must be `https`, except for `localhost`.

### Working in this repo

`.mcp.json` at the repo root registers this server for anyone who opens the
project, reading the key from the gitignored `.env`. Nothing to export.

It runs the **published** package, `npx -y @laver/mcp`, rather than the
`mcp/server.js` beside it. That is deliberate: pointing it at the local file
meant everyone here ran the one code path no user takes, and that is precisely
how 0.1.0 shipped with an entry point that never connected its transport when
started through `bin` — which is the only way a real client starts it. Running
what we publish means we meet what users meet.

**If you are editing this server**, that same choice will fool you: your changes
do nothing until they are published. Point the client at the working copy while
you work on it —

```json
{ "command": "node", "args": ["mcp/server.js"] }
```

— and put it back before you commit. `npm run check` and
`frontend/tests/check-mcp-bin-entrypoint.mjs` both run against the working copy
regardless, so the tests never depend on a publish.

**A client only connects to MCP servers at startup.** `claude mcp add` while a
session is already running does not retrofit the tools into that session — the
tool list was built before the server existed. Start a new session (or
reconnect from the client's MCP panel) and the tools appear.

## Tools

**Reading**

| Tool                  | What it gives you                                                                 |
| --------------------- | --------------------------------------------------------------------------------- |
| `list_workspaces`     | Where to start when you have no uuids                                             |
| `list_boards`         | The boards in a workspace                                                         |
| `get_board`           | A board with its status columns, labels, members and tickets                      |
| `list_tickets`        | Tickets on a board, filterable, paged — `updated_since` is how you follow a board |
| `get_ticket`          | One ticket in full, **including its `version`**                                   |
| `get_ticket_comments` | Comments and activity history                                                     |
| `search`              | Boards, tickets, wiki pages and comments across a whole workspace at once         |

To follow a board, call `list_tickets` again with `updated_since` set to the
`server_time` the previous call returned; you get back the tickets that changed
and nothing else. There is no tool for the server-sent event stream at
`GET /boards/:uuid/events` — a tool call is one request and one answer, and a
stream that never ends is neither.

**Writing**

| Tool                | Notes                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `create_ticket`     | `status` takes the column name, or pass `status_uuid`; markdown in `description` is parsed                                     |
| `update_ticket`     | Needs `version`; markdown in `description` is parsed; `custom_fields` is keyed by field uuid and **replaces** the whole object |
| `move_ticket`       | Needs `version`, and a column — neither column is a 400                                                                        |
| `comment_on_ticket` | Markdown in `body` is parsed; no `version`, so it cannot 409                                                                   |
| `archive_ticket`    | To the trash — **recoverable** for 30 days                                                                                     |
| `delete_ticket`     | Destroys one already in the trash — **permanent**                                                                              |
| `create_board`      | Optionally from a template — `crm` or `sales-leads`                                                                            |
| `link_tickets`      | "this before that" — direction is `blocks` or `blocked_by`                                                                     |
| `unlink_tickets`    | From either end, and removes **every** kind of link on the pair                                                                |

**Attachments**

| Tool                       | Notes                                                                        |
| -------------------------- | ---------------------------------------------------------------------------- |
| `list_ticket_attachments`  | Name, type, size and uuid — never the bytes                                  |
| `get_ticket_attachment`    | Text inline, an image as an image block, anything else via `save_to`         |
| `upload_ticket_attachment` | `file_path` for a file on disk, or `text` + `filename` for something written |
| `delete_ticket_attachment` | To the trash for 30 days; there is no restore tool                           |

`get_ticket` reports `attachment_total`, so you know whether listing is worth a
round trip.

Binary content crosses the tool boundary by **not** crossing it. A tool result
is text, Laver allows 25 MB per file, and 25 MB of base64 is roughly nine
million tokens — so only text, CSV and images under 4 MB come back inline, and
everything else needs `save_to`, which writes the file to a path on the machine
running this server (normally the agent's own, since the client starts it as a
subprocess). Uploads go the same way round: `file_path` reads from that machine
and costs no context.

An image comes back as an MCP image block rather than as text, which is the only
form a model can actually look at — that is the whole point of the tool, since
the screenshot somebody attached is usually the specification.

**Wiki**

`list_wikis`, `search_wiki`, `get_wiki_tree`, `get_wiki_page`,
`get_wiki_page_version`, `append_wiki_page`, and `create_wiki_page` — which
takes the body as markdown and nests under `parent_page_uuid`.

`get_wiki_page_version` is how you read something that was overwritten. It is a
read: the page does not move. There is deliberately no tool to put an old
version back, for the same reason there is none to edit a page.

Create and append only: there is no tool to edit or delete a page. Wiki pages sit behind a
live collaborative editor, so an overwrite from here would destroy whatever
somebody had open. Until that has a real conflict story the server can add to a
wiki and cannot damage one.

The markdown goes through the same parser ticket descriptions do. Headings,
lists, tables, code blocks, blockquotes, rules and links survive; so does an
`![alt](https://…)` image, as a reference to that URL — there is no tool here to
upload an attachment, so the URL has to be public already. Raw HTML is kept as
literal text rather than interpreted.

**Automations**

| Tool                | Notes                                                 |
| ------------------- | ----------------------------------------------------- |
| `list_automations`  | The rules on a board, each with its `version`         |
| `create_automation` | Owner or admin only — and see below before calling it |

An automation rule is a trigger, optional conditions and up to twenty actions,
stored against a board. Two things about them are worth knowing before an agent
touches either tool:

- **A rule created here is live immediately.** It fires on its trigger within a
  couple of seconds. Do not create one speculatively to see what it would do:
  there is no run-history tool here, so you would not see what happened.
- **A rule is a standing grant.** It runs as the user this key acts as, every
  time it is triggered, for as long as it exists — not once, like every other
  write in this server. Revoking the key does not stop it; disabling or deleting
  the rule does.

## Not covered

The REST API is larger than this server, and the difference is deliberate rather
than accidental — `mcp/route-coverage.js` lists every backend route with either
the tool that calls it or the reason it has none, and `npm run check` fails if a
route appears that is in neither. That is what keeps this section true: it went
stale before, silently, which is how the server spent its whole life unable to
read a ticket's attachments while every check stayed green.

**Not yet** — wanted, not built:

- **Notifications.** The biggest gap. An agent cannot see that it was mentioned
  or assigned, so the only way to find work aimed at it is to poll every board.
- **Subtasks.** Readable now, not writable. `get_ticket` used to give you "3 of
  7 done" and never the seven; it now returns the items themselves, so
  acceptance criteria written as a checklist can be read. Ticking one off still
  needs the REST API.
- **How long a ticket spent in each column.** `GET /tasks/:task_uuid/flow`
  derives it from the moves already in the ticket's history and has no tool yet.
  Read `visits` rather than the totals if you are adding several tickets up:
  tickets worked in one batch overlap, and their totals do not.
- **Comment editing and read state.** Comments can be posted and never amended
  or retracted, and an unread badge an agent caused cannot be cleared.
- **Board structure.** Statuses, groups and custom fields have full CRUD in
  REST and no tools, so a board created here keeps its template's defaults.
- **Labels.** `update_ticket` takes `label_uuids`; the only source of one is
  `get_board`. Nothing creates a label or lists them workspace-wide.
- **Triage and board analytics.** `GET /workspaces/:uuid/tasks` answers "what is
  overdue" and "what is unassigned" across every board, and nothing asks it.
- **Editing an automation rule.** The uncomfortable one: `create_automation`
  arms a standing rule and there is no tool to disable, edit or delete it, nor
  to read its run history — which the API does have.
- **Ticket history, duplication and recurrence.**
- **Sprints** — a whole resource with nothing pointing at it.
- **Editing and deleting a wiki page.** Waiting on a conflict story; see the
  wiki section above. Removing a whole wiki (`DELETE /wikis/:wiki_uuid`, which
  archives it and every page under it) is in the same group and is the furthest
  from a tool of anything here — nothing in that plugin reverses it.
- **Imports and feedback forms.**
- **The published-links inventory.** `GET /workspaces/:uuid/published` answers
  "what of ours is on the public internet right now", and the two DELETEs beside
  it take one link back down. One screen, one sitting, no agent story yet. The
  read is the half to add first if anybody asks; it grants no power the caller
  does not already have.

**Not ever, from a key:**

- **Public links and publishing.** Publishing turns something private into
  something anyone with the URL can read. That is consent, and a tool call is
  the wrong shape for it.
- **Workspace and membership administration.** A key acts as the person who
  created it; renaming or deleting their workspace, or answering an invitation
  for them, reaches further than delegating a board task ever meant.
- **Bulk ticket writes.** `POST /tasks/archive` bins a list in one call.
  `archive_ticket`, one at a time, is the deliberate choice.
- **Trash.** One-way on purpose: an agent can archive and can destroy what it
  already archived, and a person puts things back.
- **The board event stream.** Server-sent events; a tool call is one request and
  one answer. `list_tickets` with `updated_since` is the replacement.
- **Scheduler endpoints.** The deployment's own cron hooks.

## Removing a ticket

Two steps, deliberately, so that nothing is destroyed by a single call:

```
archive_ticket  task_uuid                    → the workspace trash, recoverable for 30 days
delete_ticket   workspace_uuid + task_uuid   → gone, and nothing brings it back
```

`delete_ticket` refuses anything that is not already archived, so the order is
enforced by the server rather than by convention. There is no restore tool here
— a ticket in the trash is put back from the web app — so treat
`archive_ticket` as the furthest you can go on your own.

Read the ticket **before** you archive it if you intend to destroy it:
`delete_ticket` needs the `workspace_uuid`, `get_ticket` is where you get one,
and an archived ticket can no longer be read.

## Working out what to do next

Every ticket read carries `blocked_by`, `blocks` and `is_blocked`. `is_blocked`
is false once every blocker has reached a completion column, so the tickets a
board is ready for are the ones where it is false. `link_tickets` records the
dependency; a link that would make a loop is refused with a 409, because a loop
makes the ordering unanswerable.

## The one rule worth knowing

Tickets carry a `version`. Every write must send the version you read, and a
write against a stale one is refused with **409** rather than silently
overwriting whoever got there first. The server turns that into an instruction,
and Laver's refusal carries the current version, so the instruction can include
it rather than spending a second call on it:

> Laver 409: Task was updated by another request.
>
> Somebody wrote first, so the version you sent is stale. The current version is 12. If your change does not depend on what you read — moving a ticket to a
> named column, say — retry with that version. If it does, call get_ticket again
> and decide against the ticket as it now is, or you will quietly undo the other
> write.

Read, then write. Do not cache a version across a long turn.

## When the key is refused

A **401** is the key: missing, mistyped, revoked, expired, or a placeholder that
was never filled in. The underlying message is not always a fair description of
what happened — a key the JWT layer cannot parse comes back as _"Authorization
token is invalid: The token is malformed"_, which sounds like a corrupted string
when the usual cause is simply a key that was replaced. The server appends what
to do about it, including the part that catches people out:

> An MCP client reads that environment once, when it starts this server, so it
> must be restarted afterwards — editing the config in a running session changes
> nothing.

A **403** is different and is never worth retrying: the key was accepted, and
then refused this particular action. It is scoped to another workspace, or the
person it acts as has a read-only role, or is a guest without access to that
board.

The key itself is read in exactly one place, sent as a bearer token, and never
logged, echoed, or included in any error text.

## Checking it

```bash
node check.js                  # schema, then every read-only tool actually called
node check.js --require-live   # …and a skipped sweep is a failure, for CI

# the same calls against the API the published package actually talks to
LAVER_API_KEY_FILE=../.env node check.js --live-api
```

Two halves. The first is static: every tool registered, classified read or
write, described, and given a schema. The second boots the backend from
`../backend` on a spare port, creates a workspace of its own, mints a key
against it, and **calls every read-only tool** — through the tool's own zod
schema and then its handler — sending every parameter the tool declares.

That half exists because the first one passed while `list_wikis` sent
`?workspace=` at a route that requires `workspace_uuid`. It 400'd on every call
it ever made, and since it is the only tool that yields a `wiki_uuid`, the whole
wiki half of this server was unreachable from the day it shipped — with
registration, descriptions and schema shape perfect throughout.

It needs the same things `npm test` in `backend/` needs: that directory, its
`node_modules`, its `.env`, and the Postgres they point at. No API key and no
network beyond localhost — a real `LAVER_API_KEY` in the environment is ignored.
Without a backend it prints a banner saying the tools were **not** called and
runs the schema half alone; `--require-live` turns that into a failure.

It is only as local as `backend/.env` is, though. Running it **writes to
whatever database that file points at**: it creates a workspace, a board, two
tickets, a comment, a wiki, a page and an API key, and deletes them again at the
end. It also loads the backend into its own process. It listens with
`app.server.listen` rather than `app.listen` — the same idiom the collab and
board-events integration tests use — so Fastify's `onListen` hooks do not fire
and none of the seven schedulers start; without that, the billing sweep alone
would run against every workspace in that database. Point `backend/.env` at
staging and this is a check that writes to staging.

The _sweep_ is read-only and stays that way: a check that creates tickets in
somebody's workspace every time it runs is a check people stop running. The
write tools are covered by the schema half only — see the note at the foot of
`check.js` for the way to cover them without sending a write.

Ctrl-C is safe. The sweep stops after the call in flight and the fixture
workspace is deleted before the process exits; a second Ctrl-C kills it outright
if the call in flight is the thing that is stuck.

### Against the deployed API

`--live-api` points the same calls at `LAVER_API_URL` — `https://api.laver.app`
unless you say otherwise — with a real key, taken from `LAVER_API_KEY` or from
the file `LAVER_API_KEY_FILE` names, exactly as the server itself takes it.

It exists because a green local run and a working published package are two
different claims. The local sweep proves the tools agree with the code in front
of you; this package talks to the deployed API, so a route that ships a rename
before the package does breaks every agent in the field while the local sweep
stays green. That is a narrow window — the tools and the routes live in one repo
and move together — but it is exactly the window publishing to npm opens.

Both modes run the same table, in `cases.js`, and every case carries an
expectation for each: exact counts locally, where the fixture is known, and
shapes and invariants live, where the workspace is somebody's real one and
cannot be seeded or torn down. A case with only one of the two is a failure, so
a new call cannot cover one transport and skip the other.

It **creates nothing and deletes nothing**, and that is enforced rather than
promised: live mode replaces `fetch` with one that refuses any method but GET,
so a write tool called by mistake cannot reach the network at all.
`frontend/tests/check-mcp-live-api-mode.mjs` runs the whole mode against a stub
API and asserts that every request that left the process was a GET.

Instead of a fixture it goes looking for something to point at, and wants a
board with at least two tickets in at least two columns, in a workspace with a
wiki that has a page. It refuses to run against anything thinner rather than
passing quietly: a filter case against an empty board passes whether or not the
filter was applied, which is the failure this whole file exists to prevent.

Opt-in, and never part of `npm run check:all` or CI — it needs a key and a
network, and neither belongs in a check that runs on a box with no secrets.

## Publishing

**0.1.0 is published and is broken. Do not tell anyone to install it.** It
starts, registers all 20 tools, connects no transport, and exits 0 without
writing anything to stdout or stderr — so a client sees the process end and
nothing else. The entry-point guard compared the _basename_ of `process.argv[1]`
against this file's name, which is true only for `node mcp/server.js`; npm's
shim for `bin` makes argv[1] `node_modules/.bin/laver-mcp`, so `npx -y
@laver/mcp` — the way this README tells everyone to run it — never matched.
Fixed in 0.1.1, and `tests/check-mcp-bin-entrypoint.mjs` now spawns the server
through a symlink and speaks MCP to it, so the same class of bug cannot ship
again.

When 0.1.1 goes out, mark the broken one so nobody lands on it:

```bash
npm deprecate @laver/mcp@0.1.0 "Never connects its stdio transport when run via npx or the bin shim. Use 0.1.1 or later."
```

Unpublishing 0.1.0 is the other option and is worse: within 72 hours it removes
the version, but the number stays burned either way, and anything that already
pinned it breaks rather than being warned.

The publish itself is the owner's to run, because it is public, permanent enough
to matter, and takes a name nobody else can then have.

**The name.** `laver` on npm is taken — v1.0.0, published in 2021 by an
unrelated maintainer — so the bare name is not available and never will be.
This package is therefore **`@laver/mcp`**: the brand name kept as the scope,
with the generic part where it belongs. Checked against the registry on
6 Aug 2026 — `@laver/mcp` is free, and nothing has ever been published under the
old unscoped `laver-mcp`, so the rename costs nothing.

**The scope exists and the first publish has happened.** `0.1.0` and `0.1.1` are
on the registry under `@laver/mcp`, created 2026-08-06T22:14Z — which is the
only proof that matters that the scope resolves and the publishing account may
write to it. This paragraph used to say the scope did not exist yet; that was
true when it was written and is not now.

Do not re-test it with `https://registry.npmjs.org/-/org/laver`. That URL is a
404 unauthenticated whether the org exists or not, so it cannot tell the two
apart — read the package document instead:

```bash
curl -s 'https://registry.npmjs.org/@laver%2Fmcp' | python3 -m json.tool
```

For a self-hosted fork publishing under its own scope, the first publish still
needs that scope created at <https://www.npmjs.com/org/create> (free for public
packages) or confirmed as the account's own username, with `npm whoami` to
check membership. `npm publish` fails with
`404 Not Found - PUT https://registry.npmjs.org/@<scope>%2fmcp` if the scope
does not exist, which reads like a network fault rather than a missing org.

**The executable stays `laver-mcp`.** The package is `@laver/mcp`, but `bin` is
deliberately not renamed to `mcp`: a global install would put a command called
`mcp` on the PATH, which is far too generic and collides with every other MCP
server anyone installs. `npx -y @laver/mcp` works regardless — npx runs the
package's only bin whatever it is called — so nothing in the config snippet
above depends on the command's name.

**`repository` and `bugs` are deliberately absent.** `github.com/Developyn/laver`
is private, and npm renders those fields as links on the package page — pointing
the only two "where does this come from" links at a 404 is worse than having
neither. `homepage` is `https://laver.app`, which is public and answers. If the
`mcp/` directory is ever mirrored to a public repo, add them back:

```json
"repository": { "type": "git", "url": "git+https://github.com/<org>/<repo>.git", "directory": "mcp" },
"bugs": { "url": "https://github.com/<org>/<repo>/issues" }
```

**Before each one**

- 2FA on the publishing account, if it is set to require it for publishing (npm
  enforces this for some accounts and packages and prompts for others). Passing
  `--otp` saves a prompt from failing a non-interactive run; drop it if not
  enrolled.
- `npm whoami` answering with that account — `npm login` if not.
- For CI instead of a laptop: an **automation** token in `NPM_TOKEN` (granular,
  write-scoped to this package). Automation tokens bypass the 2FA prompt, which
  classic read-write tokens do not.
- **A version the registry does not already have.** npm refuses to republish an
  existing one, so this is not tidying — it is what makes a publish possible at
  all. Check what is live first, because the repo's number and the registry's
  can be equal while the contents differ, and nothing warns you:
  `npm view @laver/mcp version`. Minor for new tools, patch for fixes to
  existing ones.

**The publish**

```bash
cd mcp
npm ci                    # the lockfile, not whatever resolves today
npm run check             # schema + every read-only tool actually called
npm pack --dry-run        # confirm the file list is LICENSE, README.md, package.json, server.js
npm publish --access public --otp=<code-from-your-authenticator>
```

> `npm ci` deletes and reinstalls `mcp/node_modules`. In the shared development
> checkout that directory is shared with every agent running against it, and
> removing it mid-run breaks their tests — which is why the agent instructions
> forbid it and why an agent preparing a release stops before this block. It is
> correct and expected for whoever actually publishes; just do not run it while
> others are working in the same tree.

`--access public` is **required** here: scoped packages default to restricted,
and a restricted publish on a free account is refused outright. `publishConfig`
in package.json already sets it, so the flag is belt and braces rather than the
only thing standing between this and a private package.

**Afterwards**

```bash
npx -y @laver/mcp         # should start and wait on stdio, not exit
npm view @laver/mcp
```

A mistake is recoverable only briefly: `npm unpublish @laver/mcp@<version>`
works within 72 hours, and the version number is burned afterwards regardless.
The package _name_ is not returned to the pool by unpublishing a version.

## Licence

MIT — see `LICENSE`, which ships in the package.
