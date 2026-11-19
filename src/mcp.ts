// src/mcp.ts — Model Context Protocol over Streamable HTTP, revision 2026-07-28.
//
// The client probes `server/discover` first (supportedVersions, capabilities,
// serverInfo); `initialize` + `notifications/initialized` is the pre-discover
// handshake, kept for robustness. tools/list is a constant array (byte-identical
// across calls); tools/call echoes the request's JSON-RPC id exactly and runs the
// tool against the same store REST and GraphQL use. Unknown tools are JSON-RPC
// -32602, never HTTP 500; a missing required argument is isError:true; a body
// that is not JSON is HTTP 400 with -32700; no Authorization header is 401
// (enforced by the HTTP layer, not here); notifications answer 202 with no body.

import {
  Forge,
  VIEWER_LOGIN,
  createIssueRecord,
  createPullRecord,
  mergeConflict,
  squashMerge,
} from './store.ts';
import type { Issue, PullRequest, Repo } from './store.ts';
import { issueJsonObj, pullJsonObj, repoJson } from './rest.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** The tool list, in a fixed order; the same object answers every tools/list call. */
export const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
]);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function repoFromArgs(forge: Forge, args: Record<string, unknown>): Repo | null {
  const fullName = asString(args.full_name ?? args.fullName);
  if (fullName !== null) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return forge.findRepo(fullName.slice(0, slash), fullName.slice(slash + 1)) ?? null;
  }
  const owner = asString(args.owner);
  const repo = asString(args.repo ?? args.repository);
  if (owner !== null && repo !== null) return forge.findRepo(owner, repo) ?? null;
  if (repo !== null) return forge.findRepo(VIEWER_LOGIN, repo) ?? null;
  return null;
}

function numberArg(args: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = args[key];
    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  }
  return null;
}

function issueByNumber(forge: Forge, args: Record<string, unknown>): { repo: Repo; issue: Issue } | null {
  const repo = repoFromArgs(forge, args);
  if (!repo) return null;
  const number = numberArg(args, ['issue_number', 'number']);
  if (number === null) return null;
  const issue = repo.issues.get(number);
  return issue ? { repo, issue } : null;
}

function pullByNumber(forge: Forge, args: Record<string, unknown>): { repo: Repo; pr: PullRequest } | null {
  const repo = repoFromArgs(forge, args);
  if (!repo) return null;
  const number = numberArg(args, ['pull_number', 'pullNumber', 'number', 'pull_request_number']);
  if (number === null) return null;
  const pr = repo.pulls.get(number);
  return pr ? { repo, pr } : null;
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === null) throw new Error('Missing required argument: name');
      const repo = forge.createRepo(
        repoName,
        asString(args.description) ?? '',
        args.private === true,
      );
      if (!repo) throw new Error(`repository '${repoName}' already exists`);
      return repoJson(repo);
    }
    case 'get_repo': {
      const repo = repoFromArgs(forge, args);
      if (!repo) throw new Error('repository not found');
      return repoJson(repo);
    }
    case 'create_issue': {
      const repo = repoFromArgs(forge, args);
      if (!repo) throw new Error('Missing required argument: owner/repo (repository not found)');
      const title = asString(args.title);
      if (title === null) throw new Error('Missing required argument: title');
      const issue = createIssueRecord(forge, repo, title, asString(args.body) ?? '', []);
      return issueJsonObj(repo, issue);
    }
    case 'list_issues': {
      const repo = repoFromArgs(forge, args);
      if (!repo) throw new Error('Missing required argument: owner/repo (repository not found)');
      const state = asString(args.state) ?? 'open';
      const list = [...repo.issues.values()].filter((issue) =>
        state === 'all' ? true : state === 'closed' ? issue.state === 'closed' : issue.state === 'open',
      );
      list.sort((a, b) => (a.createdSeq < b.createdSeq ? -1 : a.createdSeq > b.createdSeq ? 1 : 0));
      return list.map((issue) => issueJsonObj(repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoFromArgs(forge, args);
      if (!repo) throw new Error('Missing required argument: owner/repo (repository not found)');
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (title === null) throw new Error('Missing required argument: title');
      if (head === null) throw new Error('Missing required argument: head');
      if (base === null) throw new Error('Missing required argument: base');
      const headSha = forge.branchTip(repo, head);
      if (headSha === null) throw new Error(`head branch '${head}' does not exist`);
      const baseSha = forge.branchTip(repo, base);
      if (baseSha === null) throw new Error(`base branch '${base}' does not exist`);
      const pr = createPullRecord(forge, repo, title, asString(args.body) ?? '', head, headSha, base, baseSha);
      pr.mergeable = !mergeConflict(forge, repo, baseSha, headSha);
      return pullJsonObj(forge, repo, pr);
    }
    case 'merge_pull_request': {
      const found = pullByNumber(forge, args);
      if (!found) throw new Error('Missing required argument: pull_number (pull request not found)');
      const result = squashMerge(forge, found.repo, found.pr);
      if ('error' in result) throw new Error(result.error);
      return pullJsonObj(forge, found.repo, found.pr);
    }
    case 'get_issue': {
      const found = issueByNumber(forge, args);
      if (!found) throw new Error('issue not found');
      return issueJsonObj(found.repo, found.issue);
    }
    case 'list_pull_requests': {
      const repo = repoFromArgs(forge, args);
      if (!repo) throw new Error('Missing required argument: owner/repo (repository not found)');
      const state = asString(args.state) ?? 'open';
      const list = [...repo.pulls.values()].filter((pr) =>
        state === 'all' ? true : state === 'closed' ? pr.state === 'closed' : pr.state === 'open',
      );
      list.sort((a, b) => (a.createdSeq < b.createdSeq ? 1 : a.createdSeq > b.createdSeq ? -1 : 0));
      return list.map((pr) => pullJsonObj(forge, repo, pr));
    }
    case 'add_issue_comment': {
      const found = issueByNumber(forge, args);
      if (!found) throw new Error('issue not found');
      const body = asString(args.body);
      if (body === null) throw new Error('Missing required argument: body');
      const comment = {
        id: forge.nextCommentIdValue(),
        body,
        user: VIEWER_LOGIN,
        created_at: forge.nowIso(),
      };
      found.issue.comments.push(comment);
      found.repo.issueJson.delete(found.issue.number);
      return {
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN },
        created_at: comment.created_at,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', result, id };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

function handleOne(forge: Forge, request: unknown): Record<string, unknown> {
  if (!request || typeof request !== 'object') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = request as Record<string, unknown>;
  const id = (typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null) as JsonRpcId;
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  const method = req.method as string;
  const params = (req.params !== null && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [MCP_REVISION, '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
      const version = offered === MCP_REVISION || offered === '2025-11-25' ? offered : MCP_REVISION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object'
        ? params.arguments
        : {}) as Record<string, unknown>;
      if (!TOOLS.some((tool) => tool.name === toolName)) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      try {
        const result = runTool(forge, toolName, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      if (method.startsWith('notifications/')) return rpcResult(id, {});
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Run one MCP request body. Returns the HTTP status and the exact body bytes. */
export function handleMcp(forge: Forge, bodyText: string): { status: number; json: string } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      json: JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }),
    };
  }
  if (Array.isArray(body)) {
    return { status: 200, json: JSON.stringify(body.map((request) => handleOne(forge, request))) };
  }
  // A notification carries no id: 202 with an empty body.
  if (body !== null && typeof body === 'object' && !('id' in (body as Record<string, unknown>))) {
    handleOne(forge, body);
    return { status: 202, json: '' };
  }
  return { status: 200, json: JSON.stringify(handleOne(forge, body)) };
}
