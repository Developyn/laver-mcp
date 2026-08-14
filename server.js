#!/usr/bin/env node
/**
 * Laver MCP server.
 *
 * Every tool here is a thin call to the same public REST API the web app uses,
 * authenticated with a workspace-scoped API key. There is no second
 * implementation of anything: no local cache, no cleverness about state, no
 * business rules. If Laver refuses a write, the refusal is passed back verbatim,
 * because the agent reading it can act on "409, re-read and retry" and cannot
 * act on "something went wrong".
 *
 * Run:  LAVER_API_KEY=… npx @laver/mcp
 */

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve as resolve_path } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = (process.env.LAVER_API_URL || "https://api.laver.app").replace(
  /\/$/,
  "",
);
// LAVER_API_KEY is how anybody outside this repo supplies the key. Inside it,
// `LAVER_API_KEY_FILE` points at the gitignored file the agents already use,
// so .mcp.json can register this server without a secret in it and without
// every session needing an exported variable first. Read here and nowhere
// else; it is never logged, and a missing file is the same as no key.
//
// That file is now `.env`, which holds `LAVER_API_KEY=…` alongside other
// settings, so an assignment line wins over the file's other contents. A file
// containing nothing but the key — how this used to be pointed at `api-key.md`
// — still works, and so does anyone else's.
//
// THE FALLBACK IS NARROW ON PURPOSE, AND IT USED NOT TO BE.
//
// It used to be `contents.replace(/\s/g, "")`: every character in the file,
// whitespace stripped, sent as a Bearer token. That is right for the
// single-secret file it was written for and dangerous for anything else, and
// what it points at changed underneath it — `.env` now, and the briefing tells
// agents to copy `backend/.env` (database credentials, signing secrets) into
// their worktrees. One renamed or commented-out `LAVER_API_KEY=` line and the
// whole file would leave the machine in an `authorization` header, to whatever
// LAVER_API_URL says.
//
// So the fallback now requires the file to LOOK like a key: one token, no
// whitespace inside it. A multi-line file with no assignment yields nothing,
// and the caller gets the "not set" error below — which names the file and is
// the honest answer. Failing closed is the whole point; a wrong key is one
// clear 401, where a leaked one is silent.
const key_from_file = () => {
  const path = process.env.LAVER_API_KEY_FILE;
  if (!path) return "";
  try {
    const contents = readFileSync(path, "utf8");
    const assigned = contents.match(
      /^[ \t]*(?:export[ \t]+)?LAVER_API_KEY[ \t]*=[ \t]*(.*)$/m,
    );
    if (assigned) return assigned[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    const bare = contents.trim();
    // A key is a single token. Anything with whitespace in it is a file that
    // holds something else — possibly several something elses.
    return /^\S+$/.test(bare) ? bare : "";
  } catch {
    return "";
  }
};

/* Where the key is allowed to be sent.
 *
 * LAVER_API_URL exists so this can be pointed at a self-hosted Laver, and it is
 * read from the environment, so it is exactly as trustworthy as the environment
 * is. Plain http would put the key on the wire in clear — the thing every other
 * part of this file is careful about — so it is refused unless the host is
 * loopback, which is how the local sweep in check.js runs against a backend it
 * booted itself.
 *
 * Reported at call time rather than thrown at import, deliberately: check.js
 * imports this module to read the tool table, and an import that throws would
 * turn a misconfiguration into "the server will not start" with no tool result
 * to explain it. The refusal reaches the agent the same way a missing key does.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const api_url_refusal = (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `LAVER_API_URL is not a valid URL (${raw}). Use something like https://api.laver.app.`;
  }
  if (url.protocol === "https:") return "";
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return "";
  return `LAVER_API_URL must be an https address — ${url.protocol}//${url.host} would send your API key in the clear. Plain http is allowed only for localhost.`;
};

const API_KEY = process.env.LAVER_API_KEY || key_from_file();
const API_URL_REFUSAL = api_url_refusal(API_URL);

class LaverError extends Error {
  constructor(status, body) {
    // Both halves, deduplicated. Laver's own refusals put the whole thing in
    // `error` ("Wiki not found."), but a schema rejection is Fastify's, and
    // that puts "Bad Request" in `error` and the only useful sentence —
    // "querystring must have required property 'workspace_uuid'" — in
    // `message`. Dropping it left every drift bug reading as "Laver 400: Bad
    // Request", which names neither the parameter nor the fix.
    const detail =
      typeof body === "object" && body
        ? [...new Set([body.error, body.message].filter(Boolean))].join(" — ")
        : "";
    super(detail || `Laver returned ${status}`);
    this.status = status;
    this.body = body;
  }
}

// Every call gets a deadline. A tool call is one turn of an agent's session:
// a slow answer costs it a wait, but an answer that never comes costs it the
// session, because there is nothing for the model to react to and no way for
// it to give up. `board_events` used to prove this — a text/event-stream that
// never ends made `response.text()` a promise that never settled, and the tool
// wedged. The stream is gone from here now, but the deadline stays, because the
// next endpoint that streams or stalls should cost a tool result and not a
// session.
const REQUEST_TIMEOUT_MS = 30000;

/**
 * `form` and `binary` are the two escapes from "everything here is JSON", and
 * both exist only for attachments.
 *
 * `form` is a FormData the caller built: an upload is multipart/form-data, and
 * the content-type header is deliberately NOT set for it — fetch writes the one
 * carrying the multipart boundary, and any value we wrote here would replace it
 * with one that has no boundary, which the server cannot parse.
 *
 * `binary` returns the bytes instead of parsing them. The attachment content
 * route serves a file, not JSON, so `JSON.parse` on a PNG throws and the
 * fallback below would hand back a string built by decoding image bytes as
 * UTF-8 — silently corrupted rather than obviously wrong.
 */
const request = async (method, path, { query, body, form, binary } = {}) => {
  // Checked before the key, so a bad destination is never a reason to go
  // looking for a credential to send to it.
  if (API_URL_REFUSAL) throw new Error(API_URL_REFUSAL);
  if (!API_KEY)
    throw new Error(
      "LAVER_API_KEY is not set (and LAVER_API_KEY_FILE, if set, could not be read, or held something that is not a single key). Create a key in Laver under Admin → API keys.",
    );

  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(query || {}))
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(key, String(value));

  // The deadline covers reading the body as well as getting the headers. That
  // is the whole point: the wedge was a response whose headers arrived in
  // milliseconds and whose body never ended, so a headers-only timeout would
  // have sailed straight past it. One signal, one try, both awaits inside it.
  let response;
  let text;
  try {
    response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${API_KEY}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(form ? { body: form } : {}),
    });
    if (binary && response.ok)
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        content_type: response.headers.get("content-type") || "",
      };
    text = await response.text();
  } catch (error) {
    if (error?.name === "TimeoutError")
      throw new Error(
        `Laver did not answer ${method} ${path} within ${REQUEST_TIMEOUT_MS / 1000}s, so this call was abandoned. A read can simply be retried; for a write, re-read the ticket first — the request may still have been applied.`,
      );
    throw error;
  }

  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Left as text; an HTML error page is more useful unparsed than as an
    // exception about a stray `<`.
  }
  if (!response.ok) throw new LaverError(response.status, parsed);
  return parsed;
};

/**
 * The one exception to "tool results are text": an image the caller is meant to
 * LOOK at. MCP has an image content block for exactly this, and a screenshot
 * serialised into a JSON string is bytes the model cannot see. A handler
 * returning `blocks([...])` has its content passed through untouched; anything
 * else is serialised below.
 *
 * A symbol rather than a `content` key, because a Laver response could perfectly
 * well have a field called `content` — wiki pages do — and duck-typing on it
 * would hand the client a wiki page as if it were a content-block array.
 */
const RAW = Symbol("mcp-content-blocks");
const blocks = (content) => ({ [RAW]: content });

/**
 * Fields that are a SECOND representation of prose the reply already carries in
 * a form a model can read, and that exist for the browser's editor rather than
 * for anything here.
 *
 * `description_json` is `description` as a ProseMirror tree; `body_json` is
 * `body`. Both are several times the size of the markdown beside them, because
 * every text node sits five or six levels deep in nodes an agent has no use
 * for. Measured against this board on 7 Aug 2026: one `list_tickets` over a
 * 40-ticket column was 1,496,238 bytes as it was sent, and 217,400 bytes with
 * the indentation and these two fields removed.
 *
 * No tool on this server takes either of them as an INPUT — writes take
 * markdown — so nothing here can need them back.
 *
 * `content_json` is deliberately NOT in this set. A wiki page has no markdown
 * twin: strip its tree and the reply carries no prose at all.
 */
const EDITOR_ONLY_FIELDS = new Set(["description_json", "body_json"]);

const without_editor_fields = (value) => {
  if (Array.isArray(value)) return value.map(without_editor_fields);
  if (value && typeof value === "object" && value.constructor === Object)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !EDITOR_ONLY_FIELDS.has(key))
        .map(([key, nested]) => [key, without_editor_fields(nested)]),
    );
  return value;
};

/**
 * Two-space indentation on a deeply nested tree is more than half the payload,
 * and nothing reads it with its eyes — a tool result goes to a language model,
 * which pays for the whitespace and gets nothing for it. Set
 * `LAVER_MCP_PRETTY=1` to get it back while reading raw traffic by hand; that
 * is the only case it was ever any use for.
 */
const PRETTY = process.env.LAVER_MCP_PRETTY === "1";

/**
 * Tool results are text, so everything is serialised. Errors come back as
 * `isError` content rather than as a thrown exception: a thrown one reaches the
 * agent as a transport failure, which reads as "the tool is broken" rather than
 * "that write was refused, here is why".
 */
const result = (value) =>
  value && value[RAW]
    ? { content: value[RAW] }
    : {
        content: [
          {
            type: "text",
            text:
              typeof value === "string"
                ? value
                : JSON.stringify(
                    without_editor_fields(value),
                    null,
                    PRETTY ? 2 : undefined,
                  ),
          },
        ],
      };

// What to DO about a status, as distinct from what went wrong. The status and
// Laver's own sentence are the facts; these turn the three statuses an agent
// actually hits into an instruction it can act on without asking a human.
const hint = (error) => {
  if (error.status === 401)
    // The message underneath this is often actively misleading. A key the JWT
    // plugin cannot parse comes back as "Authorization token is invalid: The
    // token is malformed", which reads as "you corrupted this string" when the
    // ordinary cause is a key that was revoked, replaced, or a placeholder
    // never substituted into the config. Laver's own 401s are better — an
    // expired key names the date — but none of them say the one operational
    // thing the caller needs, which is that fixing the config is not enough on
    // its own.
    return "\n\nThe key was rejected: missing, mistyped, revoked, expired, or a placeholder that was never filled in. Create a new one in Laver under Admin → API keys and put it in LAVER_API_KEY, or in the file LAVER_API_KEY_FILE points at. An MCP client reads that environment once, when it starts this server, so it must be restarted afterwards — editing the config in a running session changes nothing.";
  if (error.status === 403)
    // Distinct from 401 on purpose: the key is valid and was accepted. What
    // failed is authorisation, and no amount of retrying moves it.
    return "\n\nThe key is valid but not allowed to do this: it is scoped to a different workspace, or the person it acts as has a read-only role, or is a guest without access to this board. Retrying cannot fix any of those and none of them are a version problem — use a key for the right workspace, or give its owner the access.";
  if (error.status === 409) {
    // The refusal already carries the current version, so sending the caller
    // away to fetch it spends a whole extra call on a number it is holding.
    // Re-reading is still the right move when the write depends on what was
    // read — a fresh version on its own would overwrite whatever the other
    // writer just changed, which is precisely what the version is there to
    // prevent.
    const current = error.body?.version;
    return `\n\nSomebody wrote first, so the version you sent is stale.${
      current === undefined ? "" : ` The current version is ${current}.`
    } If your change does not depend on what you read — moving a ticket to a named column, say — retry with that version. If it does, call get_ticket again and decide against the ticket as it now is, or you will quietly undo the other write.`;
  }
  return "";
};

const failure = (error) => ({
  isError: true,
  content: [
    {
      type: "text",
      text:
        error instanceof LaverError
          ? `Laver ${error.status}: ${error.message}${hint(error)}`
          : String(error?.message || error),
    },
  ],
});

// The version a client sees in the MCP handshake, read from package.json
// rather than written out a second time here. Two literals are two things to
// bump and this is the one that gets forgotten, so the published package would
// go on announcing whatever it was born with. npm always ships package.json
// inside the tarball, so this resolves the same for an installed copy as it
// does in the repo; the fallback only exists so an unreadable one costs the
// handshake a version string rather than costing the server its startup.
const VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "0.0.0";
  }
})();

const server = new McpServer({ name: "laver", version: VERSION });

const tool = (name, description, schema, handler) =>
  server.registerTool(
    name,
    { description, inputSchema: schema },
    async (args) => {
      try {
        return result(await handler(args));
      } catch (error) {
        return failure(error);
      }
    },
  );

/* The three parameters that appear on most tools, described once. They carry
 * the whole read-before-write contract between them, and a parameter an agent
 * has to infer from its name is one it eventually infers wrongly — `version`
 * especially, which looks optional and is not. Same reasoning as
 * POSITION_HINT further down. */
const TASK_UUID = z
  .string()
  .uuid()
  .describe("The ticket's uuid, from list_tickets, get_board or search");
const BOARD_UUID = z
  .string()
  .uuid()
  .describe("The board's uuid, from list_boards");
const TICKET_VERSION = z
  .number()
  .int()
  .describe(
    "The `version` from the ticket as you last read it. Not a number you choose or increment: send back exactly what get_ticket gave you. If somebody else has written since, the call answers 409 rather than overwriting them — re-read with get_ticket and retry against the new version.",
  );

// --- Reading ---------------------------------------------------------------

tool(
  "list_workspaces",
  "The workspaces this key can act in, with their uuids, names and the role it holds in each. Start here when you do not already have a workspace uuid, then go to list_boards. Through an API key this is always exactly one workspace — the one the key was issued for — even when the person who created it belongs to several, so a single entry is the normal answer rather than a sign of missing access. Archived workspaces are not in it. Each entry carries `billing_status`, which is how you tell a workspace that has gone read-only from one you can still write to, before a write fails rather than after.",
  {},
  async () => request("GET", "/workspaces"),
);

tool(
  "list_boards",
  "The boards in a workspace, with their uuids and names — where you go from a workspace to something you can actually read. It lists only the boards this key can open, so a short list means limited access rather than an empty workspace, and archived boards are not in it. The uuid you want for get_board and list_tickets is here; the status uuids those need are not — get_board has those.",
  { workspace_uuid: z.string().uuid() },
  async ({ workspace_uuid }) =>
    request("GET", `/workspaces/${workspace_uuid}/boards`),
);

/**
 * A board sends every label twice: once in the board-level dictionary and again
 * expanded in full on every ticket that carries it — uuid, name, colour and both
 * timestamps, byte for byte the dictionary entry. Measured on this board on
 * 8 Aug 2026: 69 labels in the dictionary, 233 inline copies, none absent from
 * the dictionary and none differing from it in any value. As bare uuids that is
 * 30,536 bytes off a 187,089-byte reply, 16.3%, with nothing lost, because the
 * dictionary travels in the same payload.
 *
 * The bytes are the smaller half. `label_uuids` is what `update_ticket` TAKES,
 * and `labels` is what every read GAVE — so read → modify → write, the commonest
 * write on a board, silently stripped somebody's label unless the caller
 * remembered to map `labels[].uuid` by hand. `label_uuids: undefined` is not an
 * error; it reads as "no labels" and the write succeeds. Handing back the field
 * the write takes makes the round trip correct by default rather than correct by
 * documentation.
 *
 * DELIBERATELY only here, and not in `result()` where the editor-only fields are
 * stripped. `list_tickets` and `get_ticket` carry no label dictionary beside
 * their tasks, so rewriting there would replace names and colours with uuids
 * that resolve to nothing — a real loss rather than a saving. This reply is the
 * one that has both halves.
 */
const board_label_uuids = (board) => {
  const dictionary = new Set((board?.labels || []).map((label) => label.uuid));
  // Only when every inline label is genuinely in the dictionary. If one is not,
  // the expanded copy is the only place its name exists and dropping it would
  // lose information — so the reply is left exactly as it arrived.
  const resolvable = (board?.tasks || []).every((task) =>
    (task.labels || []).every((label) => dictionary.has(label?.uuid)),
  );
  if (!board?.labels?.length || !resolvable) return board;
  return {
    ...board,
    tasks: board.tasks.map(({ labels, ...task }) => ({
      ...task,
      label_uuids: (labels || []).map((label) => label.uuid),
    })),
  };
};

/**
 * --- The size knobs -------------------------------------------------------
 *
 * `get_board`, `get_wiki_tree` and `list_tickets` are the calls an agent cannot
 * route around: a `status_uuid`, a `label_uuid` or a `custom_field` uuid comes
 * from `get_board` and nowhere else, and a `page_uuid` comes from
 * `get_wiki_tree` or a `search_wiki` hit. Measured against the Laver board on
 * 8 Aug 2026, through this file: `get_board` 153,811 bytes (159 tasks),
 * `get_wiki_tree` 118,982 bytes (212 pages), `list_tickets(status:"To Do")`
 * 185,387 bytes (46 tickets). That is ~30-45k tokens each, spent to learn one
 * uuid.
 *
 * Two rules hold this to something safe, and both are asserted in `check.js`:
 *
 *  1. **Every knob is opt-in.** A call that passes none of them returns
 *     byte-identical output to the call that could not pass them, so no
 *     existing caller changes behaviour. `without_key` below is written so the
 *     untouched path returns the SAME OBJECT, not a rebuilt copy.
 *  2. **MCP-side, not API-side.** These filter the parsed reply here rather
 *     than adding query parameters to the REST routes. The cost being paid is
 *     the tool result a model reads, the browser shares those routes, and the
 *     API side would still need this passthrough to reach an agent. There is
 *     no bandwidth saving between this server and the API — deliberately, in
 *     exchange for zero risk to every other consumer.
 *
 * Resisted on purpose: a general `fields=`/`expand=` mini-language. Three
 * parameters solve the problem and have a schema a model can read.
 */

/** Drop one key from an object, returning the SAME object when not dropping. */
const without_key = (value, key, drop) =>
  drop && value && typeof value === "object" && key in value
    ? Object.fromEntries(Object.entries(value).filter(([k]) => k !== key))
    : value;

tool(
  "get_board",
  "A board with its status columns, labels, members and tickets. The status uuids returned here are what create_ticket and move_ticket expect. Each ticket carries `label_uuids` — bare uuids, resolvable against the board's `labels` list in the same reply — which is exactly the field `update_ticket` takes, so a label read from here can be written straight back without remapping. Note that `list_tickets` and `get_ticket` still return expanded `labels` objects, because neither reply has the dictionary to resolve uuids against. The tickets are around 90% of this reply, so pass `include_tasks: false` when you came for the uuids.",
  {
    board_uuid: BOARD_UUID,
    include_tasks: z
      .boolean()
      .optional()
      .describe(
        "Set false to leave the tickets out and get the board's structure alone — statuses, labels, members, custom fields and `server_time`. That is what you want when you called this for a status_uuid or a label_uuid, and it is roughly a tenth of the bytes. Defaults to true, and the reply with it left out is unchanged. Use list_tickets when you want the tickets, since that one takes `limit` and `status`.",
      ),
  },
  async ({ board_uuid, include_tasks }) =>
    without_key(
      board_label_uuids(await request("GET", `/boards/${board_uuid}`)),
      "tasks",
      include_tasks === false,
    ),
);

tool(
  "list_tickets",
  "Tickets on a board, in board order, optionally filtered by status or by free text. This is what to read a column or walk a whole board with; get_board returns the same tickets but takes neither `limit` nor a cursor. Paging: `limit` defaults to 50 and caps at 200, and `next_cursor` comes back only on a FULL page — a short page is the end of the walk, so stop when it is absent instead of calling again, and pass it back verbatim when it is there. Following a board over time: send the `server_time` from a previous reply as `updated_since` and you get only what changed since, plus `removed_task_uuids` for tickets that left the board or went out of view. Use the server's clock for that rather than your own, which is the whole point of `server_time` — your clock can drift and silently skip a ticket. Archived tickets are never returned.",
  {
    board_uuid: z
      .string()
      .uuid()
      .describe("The board to read, from list_boards"),
    q: z
      .string()
      .optional()
      .describe(
        "Free-text search over titles and descriptions, ranked by relevance. Whole words and prefixes, not mid-word substrings. A ranked reply cannot be paged, so this cannot be combined with cursor. A UUID, or its first eight characters or more, is not searched for — it is RESOLVED: you get the ticket with that uuid and nothing else, and an empty list if there is none. It never falls back to text search, so a uuid that matches nothing means no such ticket rather than 'here are some tickets that mention it'. That sentence used to read 'a uuid finds that ticket' and was wrong in the way that costs you an afternoon: it was ranked text matching, so asking for a uuid returned every ticket whose prose quoted it — commonplace on a board where tickets cross-reference each other — with the one you asked for ranked LAST. Archived tickets are still not returned, by uuid or by text.",
      ),
    status: z
      .string()
      .optional()
      .describe(
        "A status column's name, as shown on the board — 'To Do', 'In progress'. Matched against that board's columns, so a name from another board is a 400 rather than an empty list. Use status_uuid instead when you already hold the uuid, and do not send both.",
      ),
    status_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "A status column's uuid, from get_board. The exact form of `status`, and the one to prefer once you have read the board, since it survives a column being renamed.",
      ),
    updated_since: z
      .string()
      .optional()
      .describe(
        "Return only tickets changed after this moment: an ISO 8601 timestamp, or — better — the `server_time` from a previous reply, which is the server's own clock and cannot drift against it. The reply then also carries `removed_task_uuids`, the tickets that left the board or went out of view since, which is the only way to notice a deletion by polling.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Tickets per page, 1 to 200. Defaults to 50. A reply holding exactly this many is a full page and carries a `next_cursor`; anything shorter is the last page.",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "The `next_cursor` from the previous page, passed back unchanged. It encodes a position on the board, so it is only meaningful for the same board and the same filters — do not build one yourself or reuse one across a different query, and a cursor Laver cannot read is a 400. Cannot be combined with `q`: ranked results have no stable order to page through, and asking for both is a 400 telling you so.",
      ),
    include_descriptions: z
      .boolean()
      .optional()
      .describe(
        "Set false to leave `description` off every ticket, keeping titles, statuses, labels and uuids. Bodies are around 78% of a column listing, and you have not chosen a ticket to read yet — get_ticket has the full one. Defaults to true, and the reply with it left out is unchanged.",
      ),
  },
  async ({ board_uuid, include_descriptions, ...query }) => {
    const reply = await request("GET", `/boards/${board_uuid}/tasks`, {
      query,
    });
    // `!Array.isArray` and not `|| []`: with `updated_since` this route answers
    // a delta, and inventing an empty `tasks` on a reply that did not carry one
    // would be a shape change made by a parameter that promises not to make any.
    if (include_descriptions !== false || !Array.isArray(reply.tasks))
      return reply;
    return {
      ...reply,
      tasks: reply.tasks.map((task) => without_key(task, "description", true)),
    };
  },
);

tool(
  "search",
  "Search tickets, wiki pages AND ticket comments across a whole workspace in one call, ranked by relevance with a highlighted excerpt. Use this when you know roughly what something is called but not which board or wiki it is on — list_tickets needs a board_uuid, this does not. The reply has FOUR lists: `boards` and `tasks` and `pages` matched their own text, and `comments` are tickets found by something said ABOUT them — each carries the ticket it belongs to, and a ticket already in `tasks` is never repeated there. `boards` is easy to miss and is often the one you want: it is how you find the board a term names without listing every board first. Matches whole words and prefixes, not mid-word substrings: 'deploy' finds 'deployment', 'eploy' finds nothing. Three characters minimum. Returns a short line per hit, not the full ticket or comment — follow up with get_ticket, get_ticket_comments or get_wiki_page. Each excerpt marks the matched words with the control characters \\x01 and \\x02 rather than with markup; strip them before showing the text to anyone.",
  {
    workspace_uuid: z.string().uuid(),
    q: z.string().min(1).max(200),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Results per kind, tickets and pages counted separately"),
  },
  async (query) => request("GET", "/search", { query }),
);

tool(
  "get_ticket",
  "One ticket in full: its fields, its `subtasks`, its expanded `labels` objects, and the `version` every write needs. Read this before you write. update_ticket, move_ticket, archive_ticket and the rest all take that version and answer 409 if it has moved on since you read it — that 409 is the signal to call this again and retry against the fresh version, never to drop the version or force the write. `labels` arrive expanded rather than as bare uuids because this reply carries no board dictionary to resolve them against; get_board returns `label_uuids` instead, and that bare-uuid shape is the one update_ticket wants. A ticket you cannot open answers 404, the same 404 as one that never existed, so a 404 here is not proof the ticket is gone.",
  {
    task_uuid: z
      .string()
      .uuid()
      .describe("The ticket's uuid, from list_tickets, get_board or search"),
  },
  async ({ task_uuid }) => request("GET", `/tasks/${task_uuid}`),
);

tool(
  "get_ticket_comments",
  "The discussion on a ticket, as two lists: `comments` — the thread, oldest first — and `events`, the activity history the web app draws alongside it (moves, field edits, who did what and when). The whole thread comes back in one call; there is no paging and no cursor, so a very long one is simply long. Reading is free of side effects: it does NOT mark the thread as read or clear anyone's unread badge, so polling this to follow a ticket cannot make a teammate think their comment has been seen. A ticket you cannot open is a 404, the same 404 a ticket that never existed gives.",
  { task_uuid: z.string().uuid() },
  async ({ task_uuid }) => request("GET", `/tasks/${task_uuid}/comments`),
);

tool(
  "list_ticket_attachments",
  "The files on a ticket: name, content type, size in bytes and uuid, newest first. Nothing else here reads a ticket's files, so this is the way to find out whether the specification an agent is working from is actually a PDF somebody attached. `get_ticket` reports `attachment_total`, which is how you know whether calling this is worth a round trip. Only finished uploads are listed — an upload still in flight and a deleted file both read as absent — and the reply carries metadata, never the bytes; get_ticket_attachment fetches those one at a time.",
  { task_uuid: z.string().uuid() },
  async ({ task_uuid }) => request("GET", `/tasks/${task_uuid}/attachments`),
);

// Text is returned inline; an image comes back as an image block the model can
// actually see; everything else has to be saved. The alternative — base64 in a
// text block — is what makes attachment tools useless in practice: Laver allows
// 25 MB, and 25 MB of base64 is roughly nine million tokens. So the cap below
// is not about protecting the server, it is about the one resource a tool
// result is actually spending.
const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;
const TEXT_TYPES = ["text/plain", "text/csv", "application/json"];

tool(
  "get_ticket_attachment",
  "Fetch one attachment's CONTENT, having found its uuid with list_ticket_attachments. What comes back depends on what the file is, because a tool result is text and most files are not: a text or CSV attachment is returned inline as text; an image is returned as an image block, which is the only form the model can actually look at; anything else — a PDF, a spreadsheet, a document — cannot cross this boundary as text at all, and needs `save_to`. Pass `save_to` for any file you want on disk, and for anything large: it writes the bytes to that path on the machine THIS SERVER runs on (normally the same machine as the agent, since the client starts it as a subprocess) and returns the path and size instead of the content. Files over 4 MB always need `save_to`, whatever their type, because an inline result that size costs more context than the answer is worth. Missing, still uploading, deleted, or on a ticket you cannot open are all the same 404.",
  {
    task_uuid: TASK_UUID,
    attachment_uuid: z.string().uuid(),
    save_to: z
      .string()
      .optional()
      .describe(
        "Absolute path to write the file to, on the machine running this server. Parent directories are created. An existing file is overwritten",
      ),
  },
  async ({ task_uuid, attachment_uuid, save_to }) => {
    // The listing, first, for the name and size — so that a refusal below can
    // say what the file actually is, and so a 25 MB PDF is refused before its
    // bytes are pulled across rather than after.
    const { attachments } = await request(
      "GET",
      `/tasks/${task_uuid}/attachments`,
    );
    const meta = (attachments || []).find(
      (item) => item.uuid === attachment_uuid,
    );
    if (!meta)
      throw new Error(
        `No attachment ${attachment_uuid} on ticket ${task_uuid}. list_ticket_attachments has the uuids; a file still uploading or already deleted is not in it.`,
      );

    const type = String(meta.content_type || "");
    const inline_possible =
      Number(meta.size_bytes) <= INLINE_LIMIT_BYTES &&
      (TEXT_TYPES.includes(type) || type.startsWith("image/"));
    if (!save_to && !inline_possible)
      throw new Error(
        `${meta.name} is ${type || "of unknown type"}, ${meta.size_bytes} bytes, and cannot be returned inline — pass save_to with a path to write it to. Only text, CSV and images under ${INLINE_LIMIT_BYTES / 1024 / 1024} MB come back as content.`,
      );

    const { bytes } = await request(
      "GET",
      `/tasks/${task_uuid}/attachments/${attachment_uuid}/content`,
      { binary: true },
    );

    if (save_to) {
      // Resolved against this process's cwd, which is the client's, so a
      // relative path lands somewhere the caller can predict. Reported back
      // absolute either way — "saved to ./notes.csv" is not an answer anybody
      // can act on.
      const target = resolve_path(save_to);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      return {
        saved_to: target,
        name: meta.name,
        content_type: type,
        size_bytes: bytes.length,
      };
    }

    if (type.startsWith("image/"))
      return blocks([
        {
          type: "image",
          data: bytes.toString("base64"),
          mimeType: type,
        },
      ]);
    return blocks([{ type: "text", text: bytes.toString("utf8") }]);
  },
);

// There is deliberately no `board_events` tool. `GET /boards/:uuid/events` is
// server-sent events — it hijacks the response and streams until the client
// hangs up — and the web app is the right kind of consumer for that: a long-
// lived page that reacts to each frame as it lands. A tool call is not. It is
// one request and one answer, so the best a tool could do is hold the stream
// for some arbitrary window and hand back whatever arrived; and since a frame
// carries only `{ origin }` and no board content, the agent would then have to
// go and read the board anyway. The tool used to exist, described itself as
// the cheap way to watch a board, and never returned at all.
//
// `list_tickets` with `updated_since` is the replacement and is strictly
// better: it is a normal request that ends, and it comes back with the tickets
// that changed rather than the news that something did.
//
// --- Writing ---------------------------------------------------------------

// Order within a column, and the only way an agent has of expressing it. Until
// this existed the browser was the sole client that could position anything —
// it computes a midpoint from the two cards a drag was dropped between — so
// everything an agent created or moved sorted on a number nobody had chosen.
// The server-side default (append) fixed where things LAND; this is how you say
// otherwise, and it is the same field on all three tools deliberately.
const POSITION_HINT =
  "Sort key within the column, not an index — smaller sorts higher. Read the neighbours' `position` off get_board and send a number between them; omit it to append to the bottom. Positions come back as decimal strings ('1000.000000') and are sent as numbers.";

tool(
  "create_ticket",
  "Create a ticket on a board. Give either `status` (the column name) or `status_uuid`; with neither it lands in the first column. Markdown in `description` is parsed — headings, lists and code fences all render. It is appended to the bottom of its column unless you send a `position`. The reply is the new ticket, including the `uuid` to reference it by and the `version` any later write to it will need, so there is no need to re-read it before your next call. This tool sends no idempotency key, so calling it twice makes two tickets: on a timeout or an unclear failure, use list_tickets with `q` set to the title to see whether the first one landed before you retry.",
  {
    board_uuid: z
      .string()
      .uuid()
      .describe("The board to create it on, from list_boards"),
    title: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "The ticket's title, 1 to 500 characters. This is the whole of what shows on the card, so put the specifics here rather than in the description alone.",
      ),
    description: z
      .string()
      .max(20000)
      .optional()
      .describe(
        "The body, Markdown, up to 20000 characters. Headings, lists and code fences all render.",
      ),
    status: z
      .string()
      .optional()
      .describe(
        "The column to place it in, by name as shown on the board. Must be a column on this board. Send this or `status_uuid`, not both; with neither it lands in the first column.",
      ),
    status_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "The column to place it in, by uuid, from get_board. The exact form of `status` and the one to prefer once you have read the board, since renaming a column does not break it.",
      ),
    priority: z
      .enum(["low", "medium", "high", "urgent"])
      .optional()
      .describe(
        "One of low, medium, high or urgent. Left off, the ticket simply has no priority set, which is not the same as low.",
      ),
    due_date: z
      .string()
      .optional()
      .describe("Due date as an ISO 8601 date, e.g. 2026-08-14"),
    position: z.number().optional().describe(POSITION_HINT),
  },
  async ({ board_uuid, ...body }) =>
    request("POST", `/boards/${board_uuid}/tasks`, { body }),
);

tool(
  "update_ticket",
  "Change a ticket. `version` must be the one from get_ticket; a 409 means somebody wrote first and you should re-read. Markdown in `description` is parsed, and it replaces the whole description rather than appending to it. `label_uuids`, `assignee_uuids` and `custom_fields` each REPLACE the whole set rather than adding to it, so send what is already on the ticket alongside what you are adding or you will silently remove the rest. `custom_fields` is keyed by the field's uuid — read them off get_ticket, since a name will not do — and a uuid no field on that board has is DROPPED SILENTLY rather than refused: the call answers 200 and the value is simply not there. The task in the reply carries the stored `custom_fields`, so read them back to confirm a write landed rather than assuming a 200 means it did.",
  {
    task_uuid: TASK_UUID,
    version: TICKET_VERSION,
    title: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Replaces the title. Omit to leave it as it is."),
    description: z
      .string()
      .max(20000)
      .optional()
      .describe(
        "Replaces the whole body, Markdown, up to 20000 characters — it does not append. To add a line, read the current description with get_ticket and send it back with your addition included.",
      ),
    status: z
      .string()
      .optional()
      .describe(
        "Move it to this column, by name as shown on the board. Send this or `status_uuid`, not both. move_ticket is the tool for a move alone.",
      ),
    status_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Move it to this column, by uuid, from get_board. The exact form of `status`, unaffected by a column being renamed.",
      ),
    priority: z
      .enum(["low", "medium", "high", "urgent"])
      .optional()
      .describe(
        "One of low, medium, high or urgent. Omit to leave it alone; there is no value here that clears a priority already set.",
      ),
    due_date: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Due date as an ISO 8601 date, e.g. 2026-08-14. Explicit null clears it; omitting it leaves it unchanged. Those are different, so do not send null to mean 'no change'.",
      ),
    label_uuids: z
      .array(z.string().uuid())
      .optional()
      .describe(
        "The ticket's labels, as the complete set after the write — it REPLACES rather than adds, so include the ones already on the ticket or you remove them. Bare uuids, which is the shape get_board returns as `label_uuids`; get_ticket returns expanded objects, so take the uuid out of each. An empty array removes every label.",
      ),
    assignee_uuids: z
      .array(z.string().uuid())
      .optional()
      .describe(
        "The ticket's assignees, as the complete set after the write — it REPLACES rather than adds, so include whoever is already assigned. The uuids come from the board's `members`. An empty array unassigns everyone.",
      ),
    // Deliberately as loose as the route's own schema — `typebox.Record(
    // typebox.String(), typebox.Unknown())` at backend/tasks/index.js:1754.
    // A stricter shape here (uuid keys, string values) would be this server
    // refusing calls the API accepts, which is the drift check.js exists to
    // catch: a field type added to the backend would start failing at the tool
    // while every existing call went on working, and nothing would say why.
    custom_fields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Custom field values, keyed by the FIELD's uuid — read them off get_ticket, a field's name will not work. REPLACES the whole set, so send the values already on the ticket alongside the ones you are changing. A key no field on that board has is dropped silently: the call still answers 200 and the value is simply absent, so read `custom_fields` back off the reply to confirm the write landed.",
      ),
    position: z.number().optional().describe(POSITION_HINT),
  },
  async ({ task_uuid, ...body }) =>
    request("PATCH", `/tasks/${task_uuid}`, { body }),
);

tool(
  "move_ticket",
  'Move a ticket to another column. Give either `status` (the column name) or `status_uuid` — with NEITHER this is a 400 ("body must NOT have fewer than 2 properties") and not a no-op, and with both it is a 400 saying to pick one. A column name is matched case-insensitively and trimmed, so "to do" finds "To Do", but a name no column has is a 400 naming it, and a `status_uuid` belonging to another board is refused too — get_board is where both come from. `version` must be the one get_ticket returned; a stale one is a 409 that carries the current version with it, so the retry does not need another read. The ticket is appended to the bottom of the column it arrives in unless you send a `position`; it does not keep the number it had in the column it left.',
  {
    task_uuid: TASK_UUID,
    version: TICKET_VERSION,
    status: z.string().optional().describe("Target column name"),
    status_uuid: z.string().uuid().optional(),
    position: z.number().optional().describe(POSITION_HINT),
  },
  async ({ task_uuid, ...body }) =>
    request("POST", `/tasks/${task_uuid}/move`, { body }),
);

tool(
  "comment_on_ticket",
  "Add a comment to a ticket. Markdown in `body` is parsed — headings, lists and code fences all render. Comments are not versioned: this takes no `version` and cannot 409, so it is the one write that is always safe to make against a ticket somebody else is editing, and it is the right way to report something rather than editing the description out from under them. It is also the write a read-only key can still make — a `commenter` role is refused update_ticket and move_ticket with a 403 but allowed this. A ticket you cannot open is a 404. Posting does not mark the thread read on your behalf.",
  {
    task_uuid: TASK_UUID,
    body: z.string().min(1).max(20000),
  },
  async ({ task_uuid, body }) =>
    request("POST", `/tasks/${task_uuid}/comments`, { body: { body } }),
);

// The types the upload route allows. Named here so an unacceptable file is
// refused with the list in the message, rather than reaching the route and
// coming back as a bare 415 — and checked against the backend's own set by
// mcp/check.js, because a copied allowlist that drifts starts refusing files
// the server would have taken.
const UPLOADABLE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
];
const EXTENSION_TYPES = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  log: "text/plain",
  md: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

tool(
  "upload_ticket_attachment",
  `Attach a file to a ticket — the way an agent puts evidence on a ticket rather than describing it. Two ways to give it the bytes, and exactly one must be used. \`file_path\` reads a file from the machine THIS SERVER runs on (normally the agent's own machine, since the client starts this as a subprocess) and is the right one for anything that already exists on disk; it costs no context, so prefer it. \`text\` is for content the agent has just written — a log, a CSV, a diff — and needs \`filename\` alongside it. Laver refuses anything that is not one of ${UPLOADABLE_TYPES.join(", ")}, and refuses a file whose BYTES do not match the type its name claims, so renaming a zip to .png fails at the server rather than here. 25 MB is the ceiling. A workspace over its storage quota is a 402, which no retry fixes. Uploading is a write: a read-only role is a 403.`,
  {
    task_uuid: TASK_UUID,
    file_path: z
      .string()
      .optional()
      .describe(
        "Path to an existing file on the machine running this server. Mutually exclusive with `text`",
      ),
    text: z
      .string()
      .max(1000000)
      .optional()
      .describe(
        "Literal file content, for something the agent wrote rather than something on disk. Requires `filename`",
      ),
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "The name to store it under. Required with `text`; defaults to the basename of `file_path`. Its extension decides the content type",
      ),
    content_type: z
      .enum(UPLOADABLE_TYPES)
      .optional()
      .describe("Overrides the type guessed from the filename's extension"),
  },
  async ({ task_uuid, file_path, text, filename, content_type }) => {
    if (Boolean(file_path) === Boolean(text !== undefined))
      throw new Error(
        "Give exactly one of file_path (a file on disk) or text (content to write). Neither leaves nothing to upload; both leaves it ambiguous which one you meant.",
      );

    let bytes;
    let name = filename;
    if (file_path) {
      const source = resolve_path(file_path);
      // Read before size-checking rather than after, so a path that is a
      // directory or does not exist fails as itself. statSync on a missing
      // file throws ENOENT with the path in it, which is the message worth
      // passing on.
      const stats = statSync(source);
      if (stats.size > MAX_UPLOAD_BYTES)
        throw new Error(
          `${source} is ${stats.size} bytes; Laver refuses anything over ${MAX_UPLOAD_BYTES}. Nothing was uploaded.`,
        );
      bytes = readFileSync(source);
      name = name || basename(source);
    } else {
      if (!name)
        throw new Error(
          "`text` needs `filename` — the stored name is what its extension decides the content type from, and there is no name to derive one from here.",
        );
      bytes = Buffer.from(text, "utf8");
    }

    const extension = name.includes(".")
      ? name.split(".").pop().toLowerCase()
      : "";
    const type = content_type || EXTENSION_TYPES[extension];
    if (!type)
      throw new Error(
        `Cannot tell what kind of file "${name}" is from its extension. Pass content_type explicitly, one of: ${UPLOADABLE_TYPES.join(", ")}.`,
      );

    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), name);
    return request("POST", `/tasks/${task_uuid}/attachments`, { form });
  },
);

tool(
  "delete_ticket_attachment",
  "Remove a file from a ticket. This is the same one-way-but-recoverable move archive_ticket makes: the attachment leaves the ticket immediately and its bytes sit in the workspace trash for 30 days, after which the sweep destroys them. There is no tool here to restore one — that is the web app — so treat it as final in an agent's hands. The freed bytes stop counting against the workspace's storage quota straight away. An attachment already deleted, still uploading, or on a ticket this key cannot open are all the same 404, so this never confirms that a file existed.",
  {
    task_uuid: TASK_UUID,
    attachment_uuid: z.string().uuid(),
  },
  async ({ task_uuid, attachment_uuid }) =>
    request("DELETE", `/tasks/${task_uuid}/attachments/${attachment_uuid}`),
);

// --- Removing a ticket -------------------------------------------------------
//
// Two tools rather than one, deliberately. Removal here is the two-step the
// trash is already built around: `archive_ticket` puts a ticket in the
// workspace trash, where it stays recoverable for 30 days, and `delete_ticket`
// destroys one that is already there. A single tool that archived and purged in
// one call would be the convenient shape and the wrong one — it would put one
// tool call between a mistyped uuid and content nobody, including the people
// who own it, can get back.
//
// The split is not a convention these descriptions maintain on their own. The
// destroy route refuses anything not already archived, so `delete_ticket`
// against a live ticket is a 404 and not a shortcut; the server enforces the
// order and this only has to explain it.
//
// Neither tool widens what the key can reach. Both are the same pass-through as
// everything above — the archive route scopes to the boards the caller can
// open, and the destroy route checks workspace membership and then re-checks
// board access on the row itself, precisely because destroying is the one
// action that does not come back. A uuid learned some other way is a 404 from
// here for the same reason it is a 404 from the app.

tool(
  "archive_ticket",
  "Move a ticket to the workspace trash — the recoverable half of deleting. It leaves the board, stops appearing in list_tickets and search, and get_ticket answers 404 for it, but it can be restored for 30 days from the workspace's trash in the web app, and is destroyed automatically once that window passes. This server has no restore tool, so from here archiving is a door only a person can reopen. It takes no `version` and cannot 409 — archiving is not a field edit, so there is nothing to conflict with. Already archived, never existed, and on a board you cannot open are all the same 404, so a retry is safe and a 404 tells you nothing about tickets you cannot see. If you intend to destroy the ticket permanently, call get_ticket FIRST and keep its `workspace_uuid`: delete_ticket needs one and an archived ticket can no longer be read to find it.",
  { task_uuid: z.string().uuid() },
  async ({ task_uuid }) => request("POST", `/tasks/${task_uuid}/archive`),
);

tool(
  "delete_ticket",
  "Permanently destroy a ticket that is ALREADY in the trash, along with its comments and attachments. Nothing undoes this — not the trash, not a restore, not support. It is the second step and never the first: archive_ticket, then this. A ticket still live on a board answers 404 rather than being destroyed, so this cannot bin something in one call. `workspace_uuid` must be the workspace the ticket belongs to — from get_ticket before it was archived, or get_board for the board it was on. Naming a workspace your key was not issued for is a 403 (`This API key is scoped to a different workspace.`) and never reaches the ticket; naming your own workspace for a ticket that does not live in it is a 404. Keep this for tickets that should never have existed: a duplicate, a probe, a test fixture you created. Anything a person might want back can simply be left archived, where it expires on its own. The 404 is otherwise deliberately undistinguished — not archived, already destroyed, and a board you cannot open all look identical.",
  {
    workspace_uuid: z.string().uuid(),
    // `ticket` is fixed in the path rather than exposed as a `kind` parameter.
    // The route is generic over the trash kinds — comment, attachment,
    // wiki_page — and taking the kind here would quietly make this one tool
    // that also permanently destroys wiki pages, a far larger blast radius than
    // its name admits to.
    task_uuid: TASK_UUID,
  },
  async ({ workspace_uuid, task_uuid }) =>
    request(
      "DELETE",
      `/workspaces/${workspace_uuid}/trash/ticket/${task_uuid}`,
    ),
);

tool(
  "link_tickets",
  'Record that one ticket must be finished before another can start. Direction is from the point of view of task_uuid: "blocks" means task_uuid has to be done first. Every ticket read afterwards carries `blocked_by`, `blocks` and `is_blocked`, so this is how you work out what order to do things in.',
  {
    task_uuid: z
      .string()
      .uuid()
      .describe(
        "The ticket the link is stated from, and the one `direction` is read relative to. Swapping this with other_task_uuid reverses the meaning, so decide which end you are describing before you call.",
      ),
    other_task_uuid: z
      .string()
      .uuid()
      .describe(
        "The ticket at the far end of the link. Must be a different ticket from task_uuid.",
      ),
    direction: z
      .enum(["blocks", "blocked_by"])
      .describe(
        "Read from task_uuid's side: 'blocks' means task_uuid must be finished before other_task_uuid can start; 'blocked_by' means the reverse. Unlink with unlink_tickets.",
      ),
  },
  async ({ task_uuid, ...body }) =>
    request("POST", `/tasks/${task_uuid}/relationships`, { body }),
);

tool(
  "unlink_tickets",
  "Remove the link between two tickets. Order does not matter — it finds the pair from either end, so you do not have to know which one is recorded as the blocker. Note what it removes: Laver can hold more than one kind of link between the same pair (a dependency, a related-to, a duplicate-of), a person can add the other kinds in the web app, and this removes ALL of them rather than only the dependency link_tickets creates. It is not an error to unlink a pair that was never linked — nothing matches, nothing is removed, and the call still succeeds — so this cannot be used to test whether a link exists; read `blocked_by` and `blocks` on the ticket for that. Either uuid being unreadable, on a board you cannot open, or nonexistent is a 404.",
  { task_uuid: TASK_UUID, other_task_uuid: z.string().uuid() },
  async ({ task_uuid, other_task_uuid }) =>
    request("DELETE", `/tasks/${task_uuid}/relationships/${other_task_uuid}`),
);

tool(
  "create_board",
  'Create a board in a workspace. Without `template` the board arrives with Laver\'s default columns; with one it is seeded with that template\'s columns, labels and a few example tickets. `template` accepts exactly "crm" or "sales-leads" — anything else is a 400 from the schema, so do not guess an id. A template applies once, at creation: there is no way to apply one to an existing board and no link back afterwards, so a board created without one has to be arranged by hand. A workspace you cannot open is a 404, and a 402 means the plan\'s board limit is already reached and the board was not created — neither is worth retrying.',
  {
    workspace_uuid: z.string().uuid(),
    name: z.string().min(1).max(200),
    template: z
      .enum(["crm", "sales-leads"])
      .optional()
      .describe("Omit for the default columns"),
  },
  async ({ workspace_uuid, ...body }) =>
    request("POST", `/workspaces/${workspace_uuid}/boards`, { body }),
);

// --- Automations -------------------------------------------------------------
//
// A rule is trigger + conditions + actions, stored against a board. Two tools
// rather than five: reading them and creating one are the things an agent is
// actually asked for ("set up a rule that assigns new bugs to me"), while
// editing and deleting need a `version` read first and are a worse fit for a
// single call — the same reasoning that keeps a restore tool out of the trash
// pair above.
//
// Both descriptions say that a rule created here is LIVE, and they have to.
// Creating one is the only write in this server whose effect outlives the call:
// every other tool does a thing once, where a rule keeps applying its actions,
// as a real person, until somebody removes it. An agent that treats it like an
// ordinary write — creating one speculatively, or to see what it would do — has
// armed something it cannot then observe FROM HERE. Precisely: the API does
// have a run history — GET /boards/:board_uuid/automations/:rule_uuid/runs,
// backend/automations/index.js — and this server has no tool over it. The
// distinction matters because this comment used to read as "the outcomes are
// not recorded anywhere", which sent people looking for a feature that already
// exists. The description is the only place either fact reaches the model.
//
// The trigger and action vocabularies are named in the schemas rather than left
// as free strings, so an unknown one is refused here with the valid ones in the
// message instead of arriving as a 400 to interpret. That is create_board's
// bargain and it carries create_board's cost — the lists can go stale in the
// direction where the backend gains a trigger and this tool starts refusing it
// — so check.js compares both against backend/automations/catalog.js.

const TRIGGER_TYPES = [
  "ticket.created",
  "ticket.updated",
  "ticket.moved",
  "ticket.assigned",
  "ticket.unassigned",
  "ticket.label_added",
  "ticket.label_removed",
  "ticket.priority_changed",
  "ticket.archived",
  "comment.created",
  // The two that no action produces: found by a sweep, and the only two that
  // require trigger_config.
  "schedule",
  "ticket.due",
  // The third swept one: "this ticket has been in Review for three days" is a
  // state, not an occurrence, so nothing emits it either. Needs
  // {status_uuid, days} in trigger_config.
  "ticket.in_column",
  // The fourth, and the only trigger that is about ONE ticket rather than
  // whatever caused it: "move this ticket into Review the moment Review is
  // empty". Needs {status_uuid} in trigger_config AND a `task_uuid` on the rule
  // saying which ticket moves — every other trigger refuses a task_uuid,
  // because the ticket it acts on is the one that set it off.
  "column.empty",
  // Neither an event nor a sweep. A `manual` rule is a button in the ticket
  // dialog and runs only when a person presses it — so an agent CAN create one
  // and cannot fire one: the press is POST .../run, which has no tool. That is
  // the safest rule an agent can arm, and worth saying rather than leaving to
  // be inferred, because it is the one trigger whose absence of a firing tool
  // is a feature.
  "manual",
];

// The condition vocabulary, which is a closed list for the same reason and is
// checked against the same catalogue. Operators differ per field — `title`
// cannot be asked `is`, `due_date` can only be asked whether it is set or has
// passed — so the schema takes the union and the route refuses the combinations
// that make no sense, with the operators that field does take in the message.
const CONDITION_FIELDS = [
  "status",
  "priority",
  "label",
  "assignee",
  "due_date",
  "title",
];

const CONDITION_OPERATORS = [
  "is",
  "is_not",
  "has",
  "has_not",
  "is_set",
  "is_not_set",
  "has_passed",
  "has_not_passed",
  "contains",
  "not_contains",
];

const ACTION_TYPES = [
  "move_to_status",
  "assign_user",
  "unassign_user",
  "set_priority",
  "add_label",
  "remove_label",
  "set_due_date",
  "add_comment",
  "archive_ticket",
  // The only action that leaves Laver. Where its url may point is decided when
  // the rule runs, by the same refusal the webhook endpoints use.
  "call_webhook",
  // The only action that does not act on the triggering ticket — it makes a new
  // one. On a `schedule` rule it is board-level: the rule fires ONCE rather than
  // once per ticket, and may not carry conditions or a relationship, because
  // there is no ticket for either to be about.
  "create_linked_ticket",
];

tool(
  "list_automations",
  "The automation rules on a board — each with its trigger, conditions, actions, whether it is `enabled`, the user it runs as, and the `version` any edit would need. These are live: a rule with `enabled: true` fires on its trigger within a couple of seconds and applies its actions as the person named in `run_as_user_uuid`. Read this before creating a rule on a board you did not set up, both because the per-board limit counts what is already here (two on the free plan) and because an existing rule may already do what you were about to add. There is no tool for run history, though the API has one (GET /boards/:board_uuid/automations/:rule_uuid/runs), so a rule's outcomes have to be read there rather than here. A rule that switched itself off after looping shows up here as `enabled: false`. Board access is enough to read them, which is wider than creating one. A board you cannot open is a 404, the same 404 a board that never existed gives.",
  { board_uuid: z.string().uuid() },
  async ({ board_uuid }) => request("GET", `/boards/${board_uuid}/automations`),
);

tool(
  "create_automation",
  "Create an automation rule on a board from a trigger, one to twenty actions, and optional conditions. READ THIS BEFORE CALLING IT: the rule runs as the user this API key acts as, every time it is triggered, for as long as it exists — a standing grant of that person's permissions to anybody who can cause the trigger, not a one-off write like every other tool here, and the resulting history is attributed to them. This one takes effect immediately: the rule is live as soon as it is created and fires on its trigger within a couple of seconds, so do not create one speculatively to see what it would do. Creating one requires a workspace OWNER or ADMIN — a member who can otherwise write on the board is a 403 and retrying cannot fix it. A 402 means the plan's per-board rule limit is already reached (two on free) and nothing was created. Conditions are a flat AND of field/operator/value tests and every one must hold; the operators a field accepts differ, so `title contains x` is valid where `title is x` is a 400 listing the operators title takes. `run_as_user_uuid` defaults to the key's own user, and naming somebody else is refused unless they are an active member who can write and can see the board. Rules arrive switched on unless you pass `enabled: false`. The `schedule` and `ticket.due` triggers are not events and REQUIRE `trigger_config`: a schedule fans out over every ticket the conditions select at its appointed time, in UTC, so give it conditions unless you really mean the whole board; a due-date rule fires once per ticket per threshold and never retroactively, so creating one does nothing to work that is already overdue. `column.empty` is the odd one: it is about ONE ticket rather than the board, so it requires a `task_uuid` alongside `trigger_config: {status_uuid}`, and it fires the moment that column holds nothing — which may be the moment you create it, since a column that is already empty is already empty. It also keeps doing it every time that column empties again, for ever, unless you pass `run_limit`; one-off queue entries are what people usually mean, so pass `run_limit: 1` unless a standing arrangement was actually asked for. `create_linked_ticket` is the exception to all of that: it CREATES a ticket rather than changing the triggering one, it needs a `title` (templated, so `{{now}}` makes a weekly checklist a new ticket each week) and takes an optional `description`, `status_uuid` and `relationship` (blocks, blocked_by, related_to, duplicate_of, stated from the new ticket's point of view). A schedule rule whose actions are ONLY this fires once for the board rather than once per ticket, which is what makes \"every Monday, create the release checklist\" work — and such a rule is refused if it also carries conditions, a relationship, or any action that acts on a ticket, because none of those has a ticket to be about. A ticket-triggered rule using it feeds itself, and is stopped by the depth cap after three chained runs rather than looping.",
  {
    board_uuid: BOARD_UUID,
    name: z.string().min(1).max(200),
    trigger_type: z.enum(TRIGGER_TYPES),
    trigger_config: z
      .object({
        interval: z
          .enum(["daily", "weekly", "monthly"])
          .optional()
          .describe("schedule only"),
        at: z
          .string()
          .optional()
          .describe('schedule only: time of day as "HH:MM", 24-hour UTC'),
        when: z
          .enum(["arrives", "before", "after"])
          .optional()
          .describe("ticket.due only"),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            "ticket.due only, and only with before/after — arrives takes no days",
          ),
        status_uuid: z
          .string()
          .uuid()
          .optional()
          .describe(
            "ticket.in_column and column.empty only: the column being waited on",
          ),
      })
      .optional()
      .describe(
        'Required for the schedule, ticket.due, ticket.in_column and column.empty triggers and ignored by every other one. A schedule needs {interval, at}; a due-date rule needs {when} plus {days} unless when is "arrives"; a dwell rule needs {status_uuid, days}; a column.empty rule needs {status_uuid}.',
      ),
    actions: z
      .array(z.object({ type: z.enum(ACTION_TYPES) }).passthrough())
      .min(1)
      .max(20)
      .describe(
        "Each action is an object with a `type` from the list and whatever that action needs — a status, a user, a label, a comment body",
      ),
    conditions: z
      .array(
        z.object({
          field: z.enum(CONDITION_FIELDS),
          operator: z.enum(CONDITION_OPERATORS),
          value: z
            .union([z.string(), z.number(), z.boolean()])
            .optional()
            .describe(
              "A uuid for status, label and assignee; one of none/low/medium/high/urgent for priority; text for title. Omitted for is_set, is_not_set, has_passed and has_not_passed, which take no value",
            ),
        }),
      )
      .max(20)
      .optional()
      .describe(
        "A flat AND — every condition must hold. No OR and no nesting. Omit for every occurrence of the trigger",
      ),
    enabled: z.boolean().optional(),
    run_as_user_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Defaults to the user this key acts as. Read the warning above",
      ),
    task_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "column.empty only, where it is required: the ticket the rule moves. Every other trigger refuses it, since those act on the ticket that set them off. Cannot be changed afterwards — a rule about the wrong ticket has to be deleted and made again",
      ),
    run_limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "column.empty only, and every other trigger refuses it. How many times the rule may move the ticket before it retires itself: a ticket can leave that column and the column can empty again, and without a limit the rule pulls it back in every time, indefinitely. Pass 1 unless a standing arrangement is what was actually asked for. A finished rule comes back from list_automations switched off with a `disabled_reason` saying so, and switching it back on does not give it more runs. Counts the runs that acted, successes and failures alike. Cannot be changed afterwards",
      ),
  },
  async ({ board_uuid, ...body }) =>
    request("POST", `/boards/${board_uuid}/automations`, { body }),
);

// --- Wiki ------------------------------------------------------------------

tool(
  "list_wikis",
  "The wikis in a workspace, with their uuids — the only place a `wiki_uuid` comes from, so every other wiki tool starts here. `workspace_uuid` is required; start from list_workspaces if you do not have one. An empty list is not proof the workspace has no wiki: a key acting as a guest is excluded from workspace-wide reads and sees nothing here. Archiving a wiki (done in the browser; there is no tool here for it) takes it out of this list entirely, along with every page under it — pass `archived: true` to see those instead, which is also the only way to find a `wiki_uuid` for restore_wiki.",
  // Not optional: `GET /wikis` requires it, so an omitted one is a 400 the
  // model reads as "there are no wikis". The schema is what stops the call
  // being made at all.
  {
    workspace_uuid: z.string().uuid(),
    archived: z
      .boolean()
      .optional()
      .describe(
        "Omit or false for the normal list. true swaps it for archived wikis instead — the two never mix in one reply, the same way an archived wiki never appears beside a live one in the workspace sidebar.",
      ),
  },
  async ({ workspace_uuid, archived }) =>
    request("GET", "/wikis", { query: { workspace_uuid, archived } }),
);

tool(
  "restore_wiki",
  "Undo an archive: brings a wiki, and every page under it, back into list_wikis and back onto the internet if any of its pages were published. `wiki_uuid` comes from list_wikis with `archived: true` — that is the only place one is visible at all, since an archived wiki is invisible everywhere else this server reads. A wiki that is not archived, one in a workspace this key cannot open, and a uuid that does not exist are all the same 404, so this never confirms that a wiki exists. There is deliberately no tool here that archives one in the first place: that half stays a browser action.",
  { wiki_uuid: z.string().uuid() },
  async ({ wiki_uuid }) => request("POST", `/wikis/${wiki_uuid}/restore`),
);

tool(
  "search_wiki",
  "Full-text search inside ONE wiki, returning matching pages with a highlighted excerpt. A title match outranks a body match, so the page actually about the term comes first. A single word also matches as a prefix — 'custom' finds 'Customark' — while a multi-word query keeps the usual search semantics: \"quoted phrase\", -excluded, and OR. Matches are marked in the excerpt with the control characters \\x01 and \\x02 around each hit, not with markup; strip them before showing the text to anyone. `wiki_uuid` comes from list_wikis, and a wiki that does not exist or that you cannot open is the same 404. To search tickets and wikis together across a whole workspace, use `search` instead.",
  { wiki_uuid: z.string().uuid(), q: z.string().min(1).max(500) },
  async ({ wiki_uuid, q }) =>
    request("GET", `/wikis/${wiki_uuid}/search`, { query: { q } }),
);

/**
 * The tree arrives flat, depth-first, each page already carrying `depth`
 * (0 for a top-level page) and `parent_page_uuid`. So a subtree is a contiguous
 * scan: everything after the root until the first page back at the root's own
 * depth or shallower. No parent map needed, and it cannot disagree with the
 * server's ordering the way a rebuilt tree could.
 *
 * `depth` counts LEVELS RETURNED, not the `depth` field: `depth: 1` with no
 * parent is the top-level pages, and with a parent it is that page alone. One
 * meaning either way — "how many levels of nesting do I want" — rather than a
 * number that means something different depending on the other argument.
 */
const prune_wiki_tree = (pages, root_uuid, levels) => {
  let kept = pages || [];
  let base = 0;
  if (root_uuid !== undefined) {
    const start = kept.findIndex((page) => page.uuid === root_uuid);
    // Silence here would be indistinguishable from "that page has no children",
    // and the caller would believe an empty wiki. A uuid this tree does not
    // hold is a mistake worth saying out loud.
    if (start === -1)
      throw new Error(
        `No page ${root_uuid} in this wiki. parent_page_uuid must be a page uuid from this same tree — a page in another wiki, a wiki uuid, or a page you cannot read all look like this.`,
      );
    base = kept[start].depth;
    let end = start + 1;
    while (end < kept.length && kept[end].depth > base) end += 1;
    kept = kept.slice(start, end);
  }
  if (levels !== undefined)
    kept = kept.filter((page) => page.depth - base < levels);
  return kept;
};

tool(
  "get_wiki_tree",
  "Every page in a wiki as a tree — titles, uuids and nesting — without any page content. This is the cheap way to find a page uuid when you know roughly where it sits; search_wiki is the way when you know roughly what it says. Follow up with get_wiki_page for the content of one. A wiki you cannot open is a 404, the same one a wiki that does not exist gives. A big wiki is tens of thousands of tokens of metadata, so narrow it with `parent_page_uuid` and `depth` rather than reading all of it to find one uuid.",
  {
    wiki_uuid: z.string().uuid(),
    parent_page_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Return only this page and everything nested under it. The uuid must be a page in THIS wiki — anything else is an error naming it, not an empty tree. Omit for the whole wiki.",
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "How many levels of nesting to return. 1 is the top level alone — the whole wiki's top-level pages, or just `parent_page_uuid` itself when one is given; 2 adds their children. Omit for every level.",
      ),
  },
  async ({ wiki_uuid, parent_page_uuid, depth }) => {
    const reply = await request("GET", `/wikis/${wiki_uuid}/tree`);
    if (parent_page_uuid === undefined && depth === undefined) return reply;
    return {
      ...reply,
      pages: prune_wiki_tree(reply.pages, parent_page_uuid, depth),
    };
  },
);

tool(
  "get_wiki_page",
  "One wiki page in full, with its content and any attachments it references. Get `page_uuid` from get_wiki_tree or from a search_wiki hit — a page uuid is not a wiki uuid, and passing one for the other is a 404. A page you cannot open is that same 404, so it never confirms that a page exists. This server can create a page (create_wiki_page) and add to the end of one (append_wiki_page), but cannot change or delete what is already written: to correct something, append the correction rather than planning to edit the page.",
  { page_uuid: z.string().uuid() },
  async ({ page_uuid }) => request("GET", `/wiki-pages/${page_uuid}`),
);

tool(
  "get_wiki_page_version",
  "What a wiki page said at an earlier version — its title, content and who saved it. This is how you recover something that was overwritten, and it is a READ: the page is not changed and its version does not move. Reach for it the moment you find that a page no longer says what you put there. `version` counts from 1 and goes up by one on every save; the current version is on the page from get_wiki_page. A version that was never saved, and a page you cannot open, are both the same 404. There is deliberately no tool here that puts an old version back — read it and append the wording you want, because a restore overwrites whatever a colleague has open in the live editor right now.",
  {
    page_uuid: z.string().uuid(),
    version: z
      .number()
      .int()
      .min(1)
      .describe(
        "Which save to read. 1 is the page as first created; get_wiki_page reports the current number",
      ),
  },
  async ({ page_uuid, version }) =>
    request("GET", `/wiki-pages/${page_uuid}/versions/${version}`),
);

tool(
  "create_wiki_page",
  "Write a NEW page into a wiki, with its body as markdown. This is how an agent puts findings somewhere durable instead of handing them back as chat text. `wiki_uuid` comes from list_wikis; `parent_page_uuid` (from get_wiki_tree) nests the new page under an existing one and is where a page belongs unless it is genuinely top-level. The markdown is converted server-side by the same parser ticket descriptions and comments go through — headings, lists, tables, code blocks, blockquotes, horizontal rules and links all survive. An `![alt](https://…)` image survives too, as a reference to that URL — but only for a URL already hosted somewhere public, because there is no tool here to upload an attachment, and an image the reader cannot fetch renders as a broken one. Raw HTML is kept as literal text rather than interpreted, so do not reach for it to get something markdown lacks. ADD ONLY: there is deliberately no tool to change or delete what is already on a page. Wiki pages have a live collaborative editor behind them, so a whole-document overwrite from here would silently destroy whatever a person had open at the time. Adding cannot damage anything, so it is offered and overwriting is not. Do not call this twice to 'update' a page; you will get two pages — to add to a page that already exists, use append_wiki_page. Creating a page needs write access to the workspace: a read-only role or a guest key is a 403 and retrying cannot fix it. A title is required and a body is not, so a page can be created empty and filled in by a person later.",
  {
    wiki_uuid: z.string().uuid(),
    title: z.string().min(1).max(500),
    content_markdown: z
      .string()
      .max(100000)
      .optional()
      .describe(
        "The page body as markdown. Omit for an empty page. Longer than 100k characters is refused rather than truncated",
      ),
    parent_page_uuid: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Nest under this page. Must be in the same wiki — a page from another wiki is a 400, not a silent move",
      ),
  },
  async ({ wiki_uuid, ...body }) =>
    request("POST", `/wikis/${wiki_uuid}/pages`, { body }),
);

tool(
  "append_wiki_page",
  "Add markdown to the END of a page that already exists. This is the tool for writing what you learned into your own section of a shared page — the thing create_wiki_page cannot do without leaving you a second page of the same name. It ADDS ONLY: it cannot change or remove a word that is already on the page, which is exactly why it is safe to offer where a general edit is not. There is still no tool to edit or delete existing content; if you need to correct something you appended, append the correction. Takes NO version and never conflicts — two agents appending to the same page at the same moment both get their text, in whichever order the server serialises them, and neither is asked to retry. Markdown is converted server-side by the same parser create_wiki_page uses, so headings, lists, tables, code blocks and links all survive; lead with a heading if you want your section to be findable. The reply is the page's identity and its new version, deliberately NOT the page body — appending does not need you to have read the page, and getting the whole document back is the cost this tool exists to avoid. Markdown that is only whitespace is a 400 rather than a version bump for no change. Needs write access to the workspace: a read-only role or a guest key is a 403 and retrying cannot fix it.",
  {
    page_uuid: z
      .string()
      .uuid()
      .describe(
        "From get_wiki_tree or a search_wiki hit. A wiki uuid passed here is a 404, not a page",
      ),
    content_markdown: z
      .string()
      .min(1)
      .max(100000)
      .describe(
        "Appended after everything already on the page. Longer than 100k characters is refused rather than truncated",
      ),
  },
  async ({ page_uuid, ...body }) =>
    request("POST", `/wiki-pages/${page_uuid}/append`, { body }),
);

export {
  server,
  request,
  LaverError,
  key_from_file,
  api_url_refusal,
  // For mcp/check.js, which compares them against the backend's own rather than
  // trusting a second copy. Exported from here rather than duplicated there,
  // so the check reads the values the tool actually enforces.
  UPLOADABLE_TYPES,
  MAX_UPLOAD_BYTES,
  // For mcp/check.js: the round trip it asserts is the whole point of the
  // rewrite, and asserting it against a hand-built board needs no network.
  board_label_uuids,
};

/* Only connect stdio when this file is what was actually run. Imported by
 * check.js, which would otherwise hang waiting on a transport nobody is
 * speaking to.
 *
 * Compared as resolved paths, not as basenames. This used to test whether
 * `import.meta.url` ended with the last segment of `process.argv[1]`, which is
 * true for `node server.js` and false for every other way of starting it —
 * because `bin` is `laver-mcp`, so npm's shim makes argv[1]
 * `…/node_modules/.bin/laver-mcp` and the basenames never match. The server
 * then registered its tools, connected nothing, and exited 0 in silence: no
 * error, no output, a client that just sees the process end. That is the
 * documented way to run this (`npx -y @laver/mcp`), and it shipped broken in
 * 0.1.0 — the repo's own .mcp.json says `node mcp/server.js`, which took the
 * one path that worked.
 *
 * realpathSync is what makes the bin shim resolve: it follows the symlink from
 * .bin back to this file. pathToFileURL is what makes the two comparable —
 * import.meta.url is a file:// URL and argv[1] is a plain path, so comparing
 * them raw never matches on any platform. */
const started_directly = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    // argv[1] can be something unresolvable — a deleted file, a odd embedder.
    // Not being able to prove we are the entry point means not connecting.
    return false;
  }
})();

if (started_directly) await server.connect(new StdioServerTransport());
