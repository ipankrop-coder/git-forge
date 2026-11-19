// src/rest.ts — GitHub REST v3: repositories, branches, commits, contents, issues,
// comments, labels, pull requests, files, merges.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors carry
// {"message": string}; unknown routes are 404 JSON; malformed JSON bodies are 400.
// Auth is a bearer token equal to the process's MAKEFUN_SHOP_TOKEN; a request without
// it (or with a wrong one) is 401. A repo belongs to the token's login, so the same
// repo name under another owner is 404, never 403.

import {
  Forge,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  createIssueRecord,
  createPullRecord,
  diffFiles,
  mergeConflict,
  squashMerge,
} from './store.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';

export interface RestCtx {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3 (already URL-decoded, empty segments dropped). */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when there is none / it did not parse. */
  body: unknown;
  /** The request's Host header, for absolute pagination URLs. */
  host: string;
}

export interface RestResult {
  status: number;
  /** Pre-serialised JSON body (used for the cached issue/PR reads). */
  json?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown): RestResult => ({ status: 200, body });
const created = (body: unknown): RestResult => ({ status: 201, body });
const noContent = (): RestResult => ({ status: 204, json: '' });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

// ---- serializers -------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    url: `/api/v3/repos/${repo.fullName}`,
    html_url: `https://github.com/${repo.fullName}`,
  };
}

export function issueJsonObj(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

/** The serialised issue JSON, cached per issue (the read workload hits one issue 2000x). */
export function issueJsonStr(forge: Forge, repo: Repo, issue: Issue): string {
  const cached = repo.issueJson.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueJsonObj(repo, issue));
  repo.issueJson.set(issue.number, text);
  return text;
}

export function pullJsonObj(forge: Forge, repo: Repo, pr: PullRequest): Record<string, unknown> {
  // mergeable is computed live: the base branch may have moved since the PR was opened.
  let mergeable = false;
  if (!pr.merged) {
    const baseTip = forge.branchTip(repo, pr.baseRef);
    if (baseTip !== null) mergeable = !mergeConflict(forge, repo, baseTip, pr.headSha);
  }
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergeable,
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: pr.user, id: VIEWER_ID, type: 'User' },
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.merged ? pr.updated_at : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
  };
}

export function pullJsonStr(forge: Forge, repo: Repo, pr: PullRequest): string {
  // Not cached: mergeable is computed live from the base branch.
  return JSON.stringify(pullJsonObj(forge, repo, pr));
}

function commitDate(ident: string): string {
  const match = / (\d+) [+-]\d{4}$/.exec(ident);
  if (!match) return new Date(0).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return new Date(Number(match[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const info = forge.parseCommit(repo, sha);
  if (!info) return null;
  return {
    sha,
    commit: {
      message: info.message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: commitDate(info.author) },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: commitDate(info.committer) },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

// ---- helpers -------------------------------------------------------------------

function bodyObj(ctx: RestCtx): Record<string, unknown> | null {
  const body = ctx.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  return forge.findRepo(owner, name) ?? null;
}

/**
 * Resolve a ref to a commit sha: a branch name, a full refname, "HEAD", or a raw
 * 40-hex object id that exists. Returns null when it does not resolve.
 */
function resolveRef(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  if (ref === 'HEAD') return forge.branchTip(repo, repo.defaultBranch);
  if (ref.startsWith('refs/heads/')) return repo.refs.get(ref) ?? null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const tip = forge.branchTip(repo, ref);
  if (tip !== null) return tip;
  if (/^[0-9a-f]{40}$/.test(ref) && forge.getObject(repo, ref)) return ref;
  return null;
}

function touchIssue(repo: Repo, issue: Issue): void {
  repo.issueJson.delete(issue.number);
}

function touchPull(repo: Repo, pr: PullRequest): void {
  repo.pullJson.delete(pr.number);
}

/** Paginate a list; returns the page and the Link header value (or ''). */
function paginate<T>(
  items: readonly T[],
  ctx: RestCtx,
  path: string,
): { page: T[]; link: string } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `http://${ctx.host}${path}`;
  const links: string[] = [];
  const queryFor = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${queryFor(page + 1)}>; rel="next"`);
  links.push(`<${queryFor(totalPages)}>; rel="last"`);
  if (page > 1) {
    links.push(`<${queryFor(1)}>; rel="first"`);
    links.push(`<${queryFor(page - 1)}>; rel="prev"`);
  }
  return { page: slice, link: links.join(', ') };
}

function sortIssues(issues: Issue[], ctx: RestCtx): Issue[] {
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  const sorted = [...issues];
  if (sort === 'created' || sort === 'updated') {
    sorted.sort((a, b) => (a.createdSeq < b.createdSeq ? -1 : a.createdSeq > b.createdSeq ? 1 : 0));
  }
  if (direction === 'desc') sorted.reverse();
  return sorted;
}

// ---- the router ------------------------------------------------------------------

export function handleRest(ctx: RestCtx): RestResult | null {
  const { forge, method, segments: s } = ctx;

  // API root: 200 + scopes (the starter answers this without auth).
  if (s.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (s[0] === 'meta' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }

  if (s[0] === 'user' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  if (s[0] === 'user' && s[1] === 'repos') {
    if (s.length !== 2) return err(404, 'Not Found');
    if (method === 'GET') {
      const { page, link } = paginate(forge.listRepos(), ctx, '/api/v3/user/repos');
      return {
        status: 200,
        body: page.map((repo) => repoJson(repo)),
        headers: link ? { link } : {},
      };
    }
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const name = body ? asString(body.name) : null;
      if (!name) return err(422, 'name is required');
      const repo = forge.createRepo(
        name,
        asString(body?.description) ?? '',
        body?.private === true,
      );
      if (!repo) return err(422, 'already exists');
      return created(repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // Global issue list (all repos), same filtering as the repo-scoped one.
  if (s[0] === 'issues' && s.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    const state = ctx.query.get('state') ?? 'open';
    const all: Array<{ repo: Repo; issue: Issue }> = [];
    for (const repo of forge.listRepos()) {
      for (const issue of repo.issues.values()) all.push({ repo, issue });
    }
    const filtered = all.filter(({ issue }) =>
      state === 'all' ? true : state === 'closed' ? issue.state === 'closed' : issue.state === 'open',
    );
    const sorted = [...filtered].sort((a, b) =>
      a.issue.createdSeq < b.issue.createdSeq ? -1 : a.issue.createdSeq > b.issue.createdSeq ? 1 : 0,
    );
    if ((ctx.query.get('direction') ?? 'desc') === 'desc') sorted.reverse();
    return ok(sorted.map(({ repo, issue }) => issueJsonObj(repo, issue)));
  }

  if (s[0] === 'repos' && s.length >= 3) {
    const owner = s[1];
    const name = s[2];
    const repo = resolveRepo(forge, owner, name);
    if (!repo) return err(404, 'Not Found');
    return handleRepoRoute(ctx, repo, s.slice(3));
  }

  return null;
}

// ---- repo-scoped routes ---------------------------------------------------------

function dirEntries(forge: Forge, repo: Repo, treeSha: string, prefix: string): Array<Record<string, unknown>> {
  const entries = forge.parseTree(repo, treeSha) ?? [];
  return entries
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: prefix ? `${prefix}/${entry.name}` : entry.name,
      sha: entry.sha,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function getContents(ctx: RestCtx, repo: Repo, pathParts: string[]): RestResult {
  const forge = ctx.forge;
  const tip = resolveRef(forge, repo, ctx.query.get('ref'));
  if (tip === null) return err(404, 'Not Found');
  const info = forge.parseCommit(repo, tip);
  if (!info) return err(404, 'Not Found');
  if (pathParts.length === 0) return ok(dirEntries(forge, repo, info.tree, ''));
  let treeSha = info.tree;
  for (let index = 0; index < pathParts.length; index += 1) {
    const entries = forge.parseTree(repo, treeSha);
    if (!entries) return err(404, 'Not Found');
    const entry = entries.find((candidate) => candidate.name === pathParts[index]);
    if (!entry) return err(404, 'Not Found');
    if (index === pathParts.length - 1) {
      if (entry.mode === '40000') {
        return ok(dirEntries(forge, repo, entry.sha, pathParts.join('/')));
      }
      const obj = forge.getObject(repo, entry.sha);
      if (!obj || obj.type !== 'blob') return err(404, 'Not Found');
      return ok({
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: entry.name,
        path: pathParts.join('/'),
        sha: entry.sha,
        content: obj.data.toString('base64'),
      });
    }
    if (entry.mode !== '40000') return err(404, 'Not Found');
    treeSha = entry.sha;
  }
  return err(404, 'Not Found');
}

function putContents(ctx: RestCtx, repo: Repo, pathParts: string[]): RestResult {
  const forge = ctx.forge;
  const body = bodyObj(ctx);
  if (!body) return err(400, 'a JSON body is required');
  const contentB64 = asString(body.content);
  if (contentB64 === null) return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const path = pathParts.join('/');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const message = asString(body.message) ?? `Update ${path}`;
  let tip = forge.branchTip(repo, branch) ?? forge.branchTip(repo, repo.defaultBranch);
  const flat = new Map<string, string>();
  if (tip !== null) {
    const info = forge.parseCommit(repo, tip);
    if (!info) return err(404, 'Not Found');
    for (const [key, value] of forge.flatTree(repo, info.tree)) flat.set(key, value);
  }
  const existing = flat.get(path);
  const isUpdate = existing !== undefined;
  if (isUpdate) {
    const sha = asString(body.sha);
    if (!sha || sha.toLowerCase() !== existing.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
  }
  const blobSha = forge.putObject(repo, 'blob', content);
  flat.set(path, blobSha);
  const treeSha = forge.buildTree(repo, flat);
  const commitSha = forge.createCommit(repo, treeSha, tip !== null ? [tip] : [], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  repo.fetchCache.clear();
  return {
    status: isUpdate ? 200 : 201,
    body: {
      content: {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: pathParts[pathParts.length - 1],
        path,
        sha: blobSha,
      },
      commit: { sha: commitSha },
    },
  };
}

function deleteContents(ctx: RestCtx, repo: Repo, pathParts: string[]): RestResult {
  const forge = ctx.forge;
  const body = bodyObj(ctx);
  const branch = body ? (asString(body.branch) ?? repo.defaultBranch) : repo.defaultBranch;
  const path = pathParts.join('/');
  const tip = forge.branchTip(repo, branch);
  if (tip === null) return err(404, 'Not Found');
  const info = forge.parseCommit(repo, tip);
  if (!info) return err(404, 'Not Found');
  const flat = new Map(forge.flatTree(repo, info.tree));
  const existing = flat.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  const sha = body ? asString(body.sha) : null;
  if (sha && sha.toLowerCase() !== existing.toLowerCase()) {
    return err(409, 'sha does not match the current file');
  }
  flat.delete(path);
  const treeSha = forge.buildTree(repo, flat);
  const message = body ? (asString(body.message) ?? `Delete ${path}`) : `Delete ${path}`;
  const commitSha = forge.createCommit(repo, treeSha, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  repo.fetchCache.clear();
  return ok({ commit: { sha: commitSha } });
}

function handleRepoRoute(ctx: RestCtx, repo: Repo, tail: string[]): RestResult | null {
  const { forge, method } = ctx;

  if (tail.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const body = bodyObj(ctx);
      if (body && typeof body.description === 'string') repo.description = body.description;
      repo.updated_at = forge.nowIso();
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
    if (method !== 'POST') return err(404, 'Not Found');
    const body = bodyObj(ctx);
    const ref = body ? asString(body.ref) : null;
    const sha = body ? asString(body.sha) : null;
    if (!ref || !sha) return err(422, 'ref and sha are required');
    if (!ref.startsWith('refs/')) return err(422, 'invalid ref');
    if (repo.refs.has(ref)) return err(422, 'already exists');
    if (!forge.getObject(repo, sha)) return err(422, 'object not found');
    repo.refs.set(ref, sha);
    repo.version += 1;
    repo.fetchCache.clear();
    return created({ ref, object: { sha } });
  }

  if (tail[0] === 'branches' && tail.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      forge.branchNames(repo).map((name) => ({
        name,
        commit: { sha: repo.refs.get(`refs/heads/${name}`) as string },
      })),
    );
  }

  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    const ref = ctx.query.get('sha');
    if (ref !== null) {
      const tip = resolveRef(forge, repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const list = forge.firstParentList(repo, tip);
      return ok(list.map((sha) => commitJson(forge, repo, sha)).filter(Boolean));
    }
    const tip = forge.branchTip(repo, repo.defaultBranch);
    if (tip === null) return ok([]);
    const list = forge.firstParentList(repo, tip);
    return ok(list.map((sha) => commitJson(forge, repo, sha)).filter(Boolean));
  }

  if (tail[0] === 'contents') {
    const pathParts = tail.slice(1); // Segments arrive already URL-decoded from the router.
    if (method === 'GET') return getContents(ctx, repo, pathParts);
    if (method === 'PUT') return putContents(ctx, repo, pathParts);
    if (method === 'DELETE') return deleteContents(ctx, repo, pathParts);
    return err(404, 'Not Found');
  }

  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') {
      return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const name = body ? asString(body.name) : null;
      const color = body ? asString(body.color) : null;
      if (!name) return err(422, 'name is required');
      if (repo.labels.has(name.toLowerCase())) return err(422, 'already exists');
      const label: Label = { name, color: color ?? 'ededed' };
      repo.labels.set(name.toLowerCase(), label);
      return created({ name: label.name, color: label.color });
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = [...repo.issues.values()].filter((issue) =>
        state === 'all' ? true : state === 'closed' ? issue.state === 'closed' : issue.state === 'open',
      );
      return ok(sortIssues(list, ctx).map((issue) => issueJsonObj(repo, issue)));
    }
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const title = body ? asString(body.title) : null;
      if (!title) return err(422, 'title is required');
      const rawLabels = Array.isArray(body?.labels) ? (body.labels as unknown[]) : [];
      const labels: Label[] = [];
      for (const raw of rawLabels) {
        const labelName =
          typeof raw === 'string' ? raw : raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).name === 'string'
            ? ((raw as Record<string, unknown>).name as string)
            : null;
        if (labelName === null) continue;
        const label = repo.labels.get(labelName.toLowerCase());
        if (!label) return err(422, `label '${labelName}' does not exist`);
        labels.push(label);
      }
      const issue = createIssueRecord(forge, repo, title, asString(body?.body) ?? '', labels);
      return { status: 201, json: issueJsonStr(forge, repo, issue) };
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'issues' && tail.length === 2) {
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') return { status: 200, json: issueJsonStr(forge, repo, issue) };
    if (method === 'PATCH') {
      const body = bodyObj(ctx);
      if (body) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'closed' && issue.state !== 'closed') {
          issue.state = 'closed';
          issue.closed_at = forge.nowIso();
        } else if (body.state === 'open' && issue.state !== 'open') {
          issue.state = 'open';
          issue.closed_at = null;
        }
        issue.updated_at = forge.nowIso();
      }
      touchIssue(repo, issue);
      return { status: 200, json: issueJsonStr(forge, repo, issue) };
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'issues' && tail.length === 3 && tail[2] === 'comments') {
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') {
      return ok(
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, id: VIEWER_ID, type: 'User' },
          created_at: comment.created_at,
        })),
      );
    }
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const text = body ? asString(body.body) : null;
      if (!text) return err(422, 'body is required');
      const comment = {
        id: forge.nextCommentIdValue(),
        body: text,
        user: VIEWER_LOGIN,
        created_at: forge.nowIso(),
      };
      issue.comments.push(comment);
      touchIssue(repo, issue);
      return created({
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        created_at: comment.created_at,
      });
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = [...repo.pulls.values()]
        .filter((pr) =>
          state === 'all' ? true : state === 'closed' ? pr.state === 'closed' : pr.state === 'open',
        )
        .sort((a, b) => (a.createdSeq < b.createdSeq ? 1 : a.createdSeq > b.createdSeq ? -1 : 0));
      return ok(list.map((pr) => pullJsonObj(forge, repo, pr)));
    }
    if (method === 'POST') {
      const body = bodyObj(ctx);
      const title = body ? asString(body.title) : null;
      let head = body ? asString(body.head) : null;
      let base = body ? asString(body.base) : null;
      if (!title || !head) return err(422, 'title and head are required');
      if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
      if (base && base.includes(':')) base = base.slice(base.indexOf(':') + 1);
      base = base ?? repo.defaultBranch;
      const headSha = forge.branchTip(repo, head);
      if (headSha === null) return err(422, 'head branch does not exist');
      const baseSha = forge.branchTip(repo, base);
      if (baseSha === null) return err(422, 'base branch does not exist');
      const pr = createPullRecord(
        forge,
        repo,
        title,
        asString(body?.body) ?? '',
        head,
        headSha,
        base,
        baseSha,
      );
      pr.mergeable = !mergeConflict(forge, repo, baseSha, headSha);
      return { status: 201, json: pullJsonStr(forge, repo, pr) };
    }
    return err(404, 'Not Found');
  }

  if (tail[0] === 'pulls' && tail.length === 2) {
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pr = repo.pulls.get(number);
    if (!pr) return err(404, 'Not Found');
    if (method === 'GET') return { status: 200, json: pullJsonStr(forge, repo, pr) };
    return err(404, 'Not Found');
  }

  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'files') {
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pr = repo.pulls.get(number);
    if (!pr) return err(404, 'Not Found');
    if (method !== 'GET') return err(404, 'Not Found');
    const headInfo = forge.parseCommit(repo, pr.headSha);
    if (!headInfo) return err(404, 'Not Found');
    const mb = forge.mergeBase(repo, pr.baseSha, pr.headSha);
    const mbInfo = mb ? forge.parseCommit(repo, mb) : null;
    const baseInfo = forge.parseCommit(repo, pr.baseSha);
    const baseTree = mbInfo ? mbInfo.tree : baseInfo ? baseInfo.tree : null;
    return ok(diffFiles(forge, repo, baseTree, headInfo.tree));
  }

  if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'merge') {
    const number = Number(tail[1]);
    if (!Number.isInteger(number)) return err(404, 'Not Found');
    const pr = repo.pulls.get(number);
    if (!pr) return err(404, 'Not Found');
    if (method !== 'PUT') return err(404, 'Not Found');
    const result = squashMerge(forge, repo, pr);
    if ('error' in result) {
      const status = result.error === 'Merge conflict' || result.error.startsWith('Pull request') ? 405 : 404;
      return err(status, result.error);
    }
    return ok({ sha: result.sha, merged: true, message: 'Pull request successfully merged' });
  }

  return null;
}
