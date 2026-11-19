// app.ts — the HTTP server: routing, auth, body reading.
//
//   GET  /healthz                       200 {"ok":true} (boot probe, no auth)
//   /{owner}/{repo}.git/...             git smart HTTP (public, like a public forge)
//   POST /api/graphql                   GraphQL v4 (bearer auth)
//   POST /mcp                           MCP over Streamable HTTP (bearer auth)
//   /api/v3/...                         REST v3 (bearer auth, except the GET / root)
//   anything else                       404 {"message":"Not Found"}
//
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id.
// A request to an API surface without the bearer token (or with a wrong one) is
// 401; a malformed JSON body on an API route is 400. A malformed git POST is a
// 400 that never kills the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import {
  buildV0FetchResponse,
  buildV0ReceiveAdvertisement,
  buildV0UploadAdvertisement,
  buildV2Advertisement,
  buildV2FetchResponse,
  fetchRequestFromV2Args,
  handleLsRefs,
  handleReceivePack,
  parseV0FetchRequest,
  parseV2Request,
} from './src/gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 16 * 1024 * 1024;

let requestCounter = 0;

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token must equal the process's MAKEFUN_SHOP_TOKEN (any non-empty one when unset). */
function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return presented === expected;
}

function pathSegments(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = segments[0];
  const repoName = segments[1].slice(0, -'.git'.length);
  const repo = forge.findRepo(owner, repoName);
  const tail = segments.slice(2);

  if (method === 'GET' && tail[0] === 'info' && tail[1] === 'refs') {
    const service = url.searchParams.get('service');
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      sendBytes(
        res,
        200,
        v2 ? buildV2Advertisement() : buildV0UploadAdvertisement(repo),
        'application/x-git-upload-pack-advertisement',
      );
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, buildV0ReceiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'service is required' });
    return;
  }

  if (method === 'POST' && tail[0] === 'git-upload-pack') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    try {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') {
          sendBytes(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          sendBytes(
            res,
            200,
            buildV2FetchResponse(forge, repo, fetchRequestFromV2Args(args)),
            'application/x-git-upload-pack-result',
          );
          return;
        }
        sendJson(res, 400, { message: `unknown command ${command}` });
        return;
      }
      const fetchRequest = parseV0FetchRequest(body);
      sendBytes(res, 200, buildV0FetchResponse(forge, repo, fetchRequest), 'application/x-git-upload-pack-result');
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    }
    return;
  }

  if (method === 'POST' && tail[0] === 'git-receive-pack') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    try {
      const report = handleReceivePack(forge, repo, body);
      sendBytes(res, 200, report, 'application/x-git-receive-pack-result');
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    }
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const segments = pathSegments(path);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    await handleGit(forge, req, res, segments, url);
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(forge, raw.toString('utf8'));
    if (result.status === 202) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    const result = handleGraphQL(forge, raw.toString('utf8'));
    sendJson(res, result.status, result.json);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const requestId = `req_${(++requestCounter).toString(36)}${Date.now().toString(36)}`;
    const headers = { 'x-github-request-id': requestId };
    const isRoot = path === '/api/v3' || path === '/api/v3/';
    if (!isRoot && !isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, headers);
      return;
    }
    const restSegments = segments.slice(2);
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' }, headers);
          return;
        }
      }
    }
    const result = handleRest({
      forge,
      method,
      segments: restSegments,
      query: url.searchParams,
      body,
      host: req.headers.host ?? 'localhost',
    });
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' }, headers);
      return;
    }
    const outHeaders = { ...headers, ...(result.headers ?? {}) };
    if (result.status === 204) {
      res.writeHead(204, outHeaders);
      res.end();
      return;
    }
    if (result.json !== undefined) {
      sendJson(res, result.status, result.json, outHeaders);
      return;
    }
    sendJson(res, result.status, result.body ?? {}, outHeaders);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(forge, req, res).catch((err: unknown) => {
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    });
  });
}
