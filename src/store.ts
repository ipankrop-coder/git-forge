// src/store.ts — the forge's in-memory store: git objects, refs, issues, PRs.
//
// Everything the suite creates comes through the API, so the store starts empty.
// The token names one user (the scenario viewer, adaiversen); every repo belongs
// to that login. Object ids are real git SHA-1s over "type len\0" + content, so a
// client that recomputes ids from bytes always agrees with the store.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** SHA-1 of raw bytes, as a 40-char hex string. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const OBJ_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const OBJ_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}
export interface Label {
  name: string;
  color: string;
}
export interface CommentItem {
  id: number;
  body: string;
  user: string;
  created_at: string;
}
export type IssueState = 'open' | 'closed';
export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  user: string;
  createdSeq: number;
  created_at: string;
  updated_at: string;
  comments: CommentItem[];
  closed_at: string | null;
}
export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: IssueState;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  user: string;
  createdSeq: number;
  created_at: string;
  updated_at: string;
}
export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  created_at: string;
  updated_at: string;
  /** Full refname ("refs/heads/main") -> commit/tag sha. The source of truth for branches. */
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitCache: Map<string, CommitInfo>;
  treeCache: Map<string, TreeEntry[]>;
  flatCache: Map<string, Map<string, string>>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  /** Bumped on any ref change; fetch-pack cache keys include it. */
  version: number;
  /** Fetch response cache: key -> packed response bytes (packfile section payload). */
  fetchCache: Map<string, Buffer>;
  /** Cached serialised JSON for GET /issues/{n} and GET /pulls/{n} (invalidated on mutation). */
  issueJson: Map<number, string>;
  pullJson: Map<number, string>;
}

/** The deterministic clock base: 2026-11-19T00:00:00Z, one second per tick. */
const CLOCK_BASE_MS = Date.UTC(2026, 10, 19);
const COMMIT_BASE_TS = 1763510400;

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1000000;
  private nextCommentId = 1;
  private tsSeq = 0;
  private commitClock = 0;
  /** Global creation order, shared by repos/issues/PRs (drives created_at ordering). */
  private seq = 0;

  /** A deterministic ISO timestamp (no millis, GitHub style); advances one second per call. */
  nowIso(): string {
    const ms = CLOCK_BASE_MS + this.tsSeq * 1000;
    this.tsSeq += 1;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Public counters for the domain helpers (created_at ordering, REST ids). */
  nextSeqValue(): number {
    return this.nextSeq();
  }

  nextIssueIdValue(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  // ---- repositories -------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  findRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(VIEWER_LOGIN, name))) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      fullName: `${VIEWER_LOGIN}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      created_at: now,
      updated_at: now,
      refs: new Map(),
      objects: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
      flatCache: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      version: 0,
      fetchCache: new Map(),
      issueJson: new Map(),
      pullJson: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  /** Branch tip, or null when the branch is unborn / absent. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branch names, in ref order. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    names.sort();
    return names;
  }

  // ---- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
    const sha = sha1Hex(Buffer.concat([header, data]));
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  parseCommit(repo: Repo, sha: string): CommitInfo | null {
    const cached = repo.commitCache.get(sha);
    if (cached) return cached;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    const text = obj.data.toString('utf8');
    const blank = text.indexOf('\n\n');
    const header = blank < 0 ? text : text.slice(0, blank);
    // Git stores the message with a trailing newline; the API view drops it, so
    // the message a client sent is the message it reads back.
    let message = blank < 0 ? '' : text.slice(blank + 2);
    if (message.endsWith('\n')) message = message.slice(0, -1);
    let tree = '';
    const parents: string[] = [];
    let author = '';
    let committer = '';
    for (const line of header.split('\n')) {
      if (!line) continue;
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      if (key === 'tree') tree = value;
      else if (key === 'parent') parents.push(value);
      else if (key === 'author') author = value;
      else if (key === 'committer') committer = value;
    }
    if (!/^[0-9a-f]{40}$/.test(tree)) return null;
    const info: CommitInfo = { tree, parents, author, committer, message };
    repo.commitCache.set(sha, info);
    return info;
  }

  parseTree(repo: Repo, sha: string): TreeEntry[] | null {
    const cached = repo.treeCache.get(sha);
    if (cached) return cached;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'tree') return null;
    const data = obj.data;
    const entries: TreeEntry[] = [];
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space < 0) return null;
      const nul = data.indexOf(0x00, space + 1);
      if (nul < 0 || nul + 21 > data.length) return null;
      const mode = data.subarray(offset, space).toString('ascii');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const entrySha = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, sha: entrySha });
      offset = nul + 21;
    }
    repo.treeCache.set(sha, entries);
    return entries;
  }

  /** Flat file map for a tree: path -> blob sha (directories expanded). */
  flatTree(repo: Repo, treeSha: string): Map<string, string> {
    const cached = repo.flatCache.get(treeSha);
    if (cached) return cached;
    const out = new Map<string, string>();
    const walk = (sha: string, prefix: string): void => {
      const entries = this.parseTree(repo, sha);
      if (!entries) return;
      for (const entry of entries) {
        if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
        else out.set(`${prefix}${entry.name}`, entry.sha);
      }
    };
    walk(treeSha, '');
    repo.flatCache.set(treeSha, out);
    return out;
  }

  /** Build (and store) the tree objects for a flat path -> blob map; returns the root sha. */
  buildTree(repo: Repo, flat: Map<string, string>): string {
    const buildLevel = (entries: Array<[string, string]>): string => {
      const files: TreeEntry[] = [];
      const dirs = new Map<string, Array<[string, string]>>();
      for (const [path, sha] of entries) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          files.push({ mode: '100644', name: path, sha });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          const list = dirs.get(dir);
          if (list) list.push([rest, sha]);
          else dirs.set(dir, [[rest, sha]]);
        }
      }
      const out: TreeEntry[] = [...files];
      for (const [dir, sub] of dirs) out.push({ mode: '40000', name: dir, sha: buildLevel(sub) });
      // git sorts by name, directories as if the name had a trailing slash
      out.sort((a, b) => {
        const ka = a.name + (a.mode === '40000' ? '/' : '');
        const kb = b.name + (b.mode === '40000' ? '/' : '');
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      const parts: Buffer[] = [];
      for (const entry of out) {
        parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
        parts.push(Buffer.from(entry.sha, 'hex'));
      }
      return this.putObject(repo, 'tree', Buffer.concat(parts));
    };
    return buildLevel([...flat.entries()]);
  }

  /** Create a commit object with a deterministic timestamp; returns its sha. */
  createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const ts = COMMIT_BASE_TS + this.commitClock;
    this.commitClock += 1;
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident}`, `committer ${ident}`, '', message);
    return this.putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
  }

  // ---- ancestry -------------------------------------------------------------

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const info = this.parseCommit(repo, cur);
      if (!info) continue;
      for (const parent of info.parents) stack.push(parent);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const distA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [cur, dist] = queueA.shift() as [string, number];
      if (distA.has(cur)) continue;
      distA.set(cur, dist);
      const info = this.parseCommit(repo, cur);
      if (!info) continue;
      for (const parent of info.parents) queueA.push([parent, dist + 1]);
    }
    let best: string | null = null;
    let bestDist = Infinity;
    const seenB = new Set<string>();
    const queueB: Array<[string, number]> = [[b, 0]];
    while (queueB.length > 0) {
      const [cur, dist] = queueB.shift() as [string, number];
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      const da = distA.get(cur);
      if (da !== undefined && dist + da < bestDist) {
        bestDist = dist + da;
        best = cur;
      }
      const info = this.parseCommit(repo, cur);
      if (!info) continue;
      for (const parent of info.parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** First-parent chain from a tip, newest first. */
  firstParentList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = tip;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      const info = this.parseCommit(repo, cur);
      cur = info && info.parents.length > 0 ? info.parents[0] : null;
    }
    return out;
  }

  /** All objects reachable from a set of commits (commits + trees + blobs), by sha. */
  reachableObjects(repo: Repo, tips: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (out.has(sha)) continue;
      const obj = repo.objects.get(sha);
      if (!obj) continue;
      out.add(sha);
      if (obj.type === 'commit') {
        const info = this.parseCommit(repo, sha);
        if (!info) continue;
        stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        const entries = this.parseTree(repo, sha);
        if (!entries) continue;
        for (const entry of entries) stack.push(entry.sha);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      }
    }
    return out;
  }
}

/** The `object` line of a tag object, or null. */
export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) return line.slice('object '.length).trim();
  }
  return null;
}

/** Parse a tag object fully (object, type, tag name, tagger). */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string } | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7).trim();
  }
  if (!object || !type || !tag) return null;
  return { object, type, tag, tagger };
}

/** Count lines in a blob (a trailing newline does not start a new line). */
export function countLines(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export function linesOf(data: Buffer | undefined): string[] {
  if (!data || data.length === 0) return [];
  const parts = data.toString('utf8').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Per-file diff between two trees (either may be null for an empty tree). */
export function diffFiles(forge: Forge, repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree ? forge.flatTree(repo, baseTree) : new Map<string, string>();
  const head = headTree ? forge.flatTree(repo, headTree) : new Map<string, string>();
  const out: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const additions = countLines(forge.getObject(repo, h as string)?.data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined) {
      const deletions = countLines(forge.getObject(repo, b)?.data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const bLines = linesOf(forge.getObject(repo, b)?.data);
      const hLines = linesOf(forge.getObject(repo, h)?.data);
      const bSet = new Set(bLines);
      const hSet = new Set(hLines);
      let additions = 0;
      let deletions = 0;
      for (const line of hLines) if (!bSet.has(line)) additions += 1;
      for (const line of bLines) if (!hSet.has(line)) deletions += 1;
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

/** True when the head and the base branch both changed a file differently since the merge-base. */
export function mergeConflict(forge: Forge, repo: Repo, baseTipSha: string, headSha: string): boolean {
  const baseInfo = forge.parseCommit(repo, baseTipSha);
  const headInfo = forge.parseCommit(repo, headSha);
  if (!baseInfo || !headInfo) return false;
  const mb = forge.mergeBase(repo, baseTipSha, headSha);
  if (!mb) return true;
  const mbInfo = forge.parseCommit(repo, mb);
  if (!mbInfo) return true;
  const mbFlat = forge.flatTree(repo, mbInfo.tree);
  const headFlat = forge.flatTree(repo, headInfo.tree);
  const baseFlat = forge.flatTree(repo, baseInfo.tree);
  const paths = new Set<string>([...mbFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
  for (const path of paths) {
    const m = mbFlat.get(path);
    const h = headFlat.get(path);
    const b = baseFlat.get(path);
    if (h !== m && b !== m && h !== b) return true;
  }
  return false;
}

// ---- global ids ------------------------------------------------------------
// Opaque ids: base64url of a typed string ("Repository:12", "Issue:12:3").

export function gid(kind: string, repoId: number, num?: number): string {
  const raw = num === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${num}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; repoId: number; num?: number } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const kind = parts[0];
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId) || repoId <= 0) return null;
    if (parts.length === 3) {
      const num = Number(parts[2]);
      if (!Number.isInteger(num) || num <= 0) return null;
      return { kind, repoId, num };
    }
    return { kind, repoId };
  } catch {
    return null;
  }
}

// ---- issue / pull-request creation ------------------------------------------

export function createIssueRecord(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labels: Label[],
): Issue {
  const now = forge.nowIso();
  const issue: Issue = {
    number: repo.nextNumber,
    id: forge.nextIssueIdValue(),
    title,
    body,
    state: 'open',
    labels,
    user: VIEWER_LOGIN,
    createdSeq: forge.nextSeqValue(),
    created_at: now,
    updated_at: now,
    comments: [],
    closed_at: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  repo.issueJson.delete(issue.number);
  return issue;
}

export function createPullRecord(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  headSha: string,
  baseRef: string,
  baseSha: string,
): PullRequest {
  const now = forge.nowIso();
  const pr: PullRequest = {
    number: repo.nextNumber,
    id: forge.nextIssueIdValue(),
    title,
    body,
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergeable: true,
    mergeCommitSha: null,
    mergedAt: null,
    user: VIEWER_LOGIN,
    createdSeq: forge.nextSeqValue(),
    created_at: now,
    updated_at: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pr.number, pr);
  repo.pullJson.delete(pr.number);
  return pr;
}

/**
 * Squash-merge a pull request onto its base branch: one commit on the base branch
 * whose tree is the head's tree, parented on the base tip. Returns the merge commit
 * sha, or an error string. Shared by the REST merge route and the GraphQL mutation.
 */
export function squashMerge(
  forge: Forge,
  repo: Repo,
  pr: PullRequest,
): { sha: string } | { error: string } {
  if (pr.merged) return { error: 'Pull request is already merged' };
  if (pr.state !== 'open') return { error: 'Pull request is closed' };
  const headInfo = forge.parseCommit(repo, pr.headSha);
  const baseTip = forge.branchTip(repo, pr.baseRef);
  if (!headInfo || baseTip === null) return { error: 'branch not found' };
  if (mergeConflict(forge, repo, baseTip, pr.headSha)) return { error: 'Merge conflict' };
  const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
  const mergeSha = forge.createCommit(repo, headInfo.tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
  repo.version += 1;
  repo.fetchCache.clear();
  pr.merged = true;
  pr.state = 'closed';
  pr.mergeCommitSha = mergeSha;
  pr.mergedAt = forge.nowIso();
  pr.baseSha = mergeSha;
  pr.updated_at = forge.nowIso();
  repo.pullJson.delete(pr.number);
  return { sha: mergeSha };
}
