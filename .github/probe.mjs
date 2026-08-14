/* Does the packaged server actually start and describe itself?
 *
 * The npm tarball is three files and the Dockerfile copies them into a bare
 * node image, so the ways this breaks are not subtle: a dependency that no
 * longer resolves, an import of something `files` does not ship, a syntax
 * error in a hand-edited mirror. All of them look identical from outside —
 * the process exits and a client reports "server disconnected" with nothing
 * to go on.
 *
 * So this speaks the real protocol over stdio rather than checking the image
 * exists: initialize, initialized, tools/list. That is exactly the handshake
 * every directory and every client performs first, and it is the one Glama
 * runs when it builds the Dockerfile to score the server.
 *
 * Deliberately WITHOUT LAVER_API_KEY. Introspection must work unauthenticated
 * — an agent lists the tools before it has any reason to hold a credential,
 * and a server that demands a key at startup is one no directory can index.
 * If someone "fixes" the server to exit without a key, this fails, and that
 * is the point.
 *
 * Usage: node .github/probe.mjs <docker-image-tag>
 */

import { spawn } from 'node:child_process';

const image = process.argv[2];
if (!image) {
    console.error('usage: node .github/probe.mjs <docker-image-tag>');
    process.exit(2);
}

const REQUESTS = [
    {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'laver-mcp-ci-probe', version: '1.0.0' },
        },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
];

// `-i` for stdin, and no `-e LAVER_API_KEY` on purpose. See the note above.
const child = spawn('docker', ['run', '-i', '--rm', image], {
    stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => (stdout += chunk));
child.stderr.on('data', chunk => (stderr += chunk));

/* A stuck handshake is the failure this is most likely to catch, and without a
 * timeout it presents as a job that hangs until the runner's own limit kills
 * it — six minutes of nothing instead of a message. */
const deadline = setTimeout(() => {
    child.kill('SIGKILL');
    fail('the server did not answer initialize and tools/list within 30s');
}, 30_000);

const fail = message => {
    clearTimeout(deadline);
    console.error(`FAIL: ${message}`);
    if (stdout.trim()) console.error(`\n--- stdout ---\n${stdout.trim()}`);
    if (stderr.trim()) console.error(`\n--- stderr ---\n${stderr.trim()}`);
    process.exit(1);
};

for (const request of REQUESTS) child.stdin.write(`${JSON.stringify(request)}\n`);
child.stdin.end();

child.on('error', error => fail(`could not run docker: ${error.message}`));

child.on('close', code => {
    clearTimeout(deadline);

    // Every line is one JSON-RPC message; anything else on stdout is a server
    // that logged where the protocol lives, which corrupts the stream.
    const messages = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
            messages.push(JSON.parse(line));
        } catch {
            return fail(`non-JSON line on stdout, which breaks stdio framing: ${line.slice(0, 200)}`);
        }
    }

    const initialize = messages.find(message => message.id === 1);
    if (!initialize) return fail(`no reply to initialize (exit code ${code})`);
    if (initialize.error)
        return fail(`initialize returned an error: ${JSON.stringify(initialize.error)}`);

    const server = initialize.result?.serverInfo;
    if (!server?.name) return fail('initialize replied without serverInfo.name');

    const listed = messages.find(message => message.id === 2);
    if (!listed) return fail(`no reply to tools/list (exit code ${code})`);
    if (listed.error)
        return fail(`tools/list returned an error: ${JSON.stringify(listed.error)}`);

    const tools = listed.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0)
        return fail('tools/list returned no tools');

    /* Every tool needs a description and a schema, because a directory that
     * cannot read them lists the server with an empty tool surface — and
     * Glama's quality score is computed from exactly these two fields. */
    const undescribed = tools.filter(tool => !tool.description?.trim());
    if (undescribed.length)
        return fail(
            `${undescribed.length} tool(s) have no description: ${undescribed
                .map(tool => tool.name)
                .join(', ')}`
        );

    const unschemad = tools.filter(tool => !tool.inputSchema);
    if (unschemad.length)
        return fail(
            `${unschemad.length} tool(s) have no inputSchema: ${unschemad
                .map(tool => tool.name)
                .join(', ')}`
        );

    console.log(
        `OK: ${server.name} ${server.version ?? ''}`.trim() +
            ` answered the handshake with ${tools.length} tools, all described and schema'd, with no LAVER_API_KEY set.`
    );
});
