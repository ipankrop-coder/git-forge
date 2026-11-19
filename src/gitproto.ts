// src/gitproto.ts — the git smart-HTTP wire: pkt-lines, packfiles, upload-pack v2,
// receive-pack v0. Everything here is built from the suite client's own wire format
// (program/env/src/git-client.ts): v2 capability advertisement with `fetch` and
// `ls-refs`, v0 advertisements with the `# service=` preamble, side-band-64k framing,
// and packfiles with full objects (no deltas) and a correct SHA-1 trailer.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  Forge,
  OBJ_CODE_TYPE,
  OBJ_TYPE_CODE,
  ZERO_OID,
  parseTagTarget,
  sha1Hex,
} from './store.ts';
import type { ObjType, Repo } from './store.ts';

// ---- pkt-lines ---------------------------------------------------------------

/** One pkt-line: 4 hex digits of (payload length + 4) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PktItem = string | Buffer | 'flush' | 'delim';

/** Encode a list of pkt-lines; strings are taken as the payload (with their \n). */
export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines (no raw pack bytes inside). Throws on malformed input. */
export function decodePktLines(buf: Buffer): DecodedPacket[] {
  const out: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line truncated');
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('pkt-line has a bad length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split a receive-pack body into pkt-line commands and the raw pack that follows the flush. */
export function splitCommandsAndPack(body: Buffer): { commands: string[]; pack: Buffer } {
  const commands: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('bad pkt-line length in push');
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) throw new Error('pkt-line out of range in push');
    commands.push(body.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  return { commands, pack: body.subarray(offset) };
}

// ---- packfiles ---------------------------------------------------------------

export interface PackObject {
  type: ObjType;
  data: Buffer;
  sha: string;
}

/** Build a packfile (version 2, full objects, SHA-1 trailer) from objects. */
export function buildPack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = OBJ_TYPE_CODE[obj.type];
    const size = obj.data.length;
    const varint: number[] = [];
    let byte = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) byte |= 0x80;
    varint.push(byte);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      varint.push(b);
    }
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one zlib stream starting at `offset`. inflateSync ignores trailing bytes and
 * throws on a truncated stream, so the deflated length is the smallest length that
 * inflates — found by binary search, bounded by the raw size + slack (a deflate stream
 * is never much larger than its raw bytes).
 */
export function inflateObject(buf: Buffer, offset: number, rawSize: number): { data: Buffer; next: number } {
  const remaining = buf.length - offset;
  const hi = Math.min(remaining, rawSize + 1024);
  // The whole remainder must inflate (it carries this stream plus whatever follows).
  inflateSync(buf.subarray(offset));
  let lo = 1;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      high = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, offset + lo));
  return { data, next: offset + lo };
}

/** Parse a packfile into its objects (full objects only; deltas are rejected). */
export function parsePack(buf: Buffer): PackObject[] {
  if (buf.length < 12) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has a bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects: PackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    if (offset >= buf.length) throw new Error('pack truncated before all objects');
    let byte = buf[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= buf.length) throw new Error('pack object header truncated');
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta objects are not supported');
    const type = OBJ_CODE_TYPE[typeCode];
    if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    const { data, next } = inflateObject(buf, offset, size);
    if (data.length !== size) throw new Error('pack object size mismatch');
    offset = next;
    const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
    const sha = sha1Hex(Buffer.concat([header, data]));
    objects.push({ type, data, sha });
  }
  // Trailer: 20 bytes of SHA-1 over everything before it, when present.
  if (buf.length - offset === 20) {
    const expected = sha1Hex(buf.subarray(0, offset));
    const actual = buf.subarray(offset, offset + 20).toString('hex');
    if (expected !== actual) throw new Error('pack trailer checksum mismatch');
  }
  return objects;
}

// ---- advertisements ----------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ oid, name }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** v0 ref advertisement (upload-pack): `# service=` preamble, HEAD first with caps. */
export function buildV0UploadAdvertisement(repo: Repo): Buffer {
  const caps =
    `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band side-band-64k ` +
    'ofs-delta shallow deepen-since deepen-not';
  const lines: PktItem[] = ['# service=git-upload-pack\n', 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v0 ref advertisement (receive-pack): v0 only, with report-status / side-band-64k / delete-refs. */
export function buildV0ReceiveAdvertisement(repo: Repo): Buffer {
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} report-status side-band-64k delete-refs`;
  const lines: PktItem[] = ['# service=git-receive-pack\n', 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v2 capability advertisement (upload-pack): `version 2` + capability lines. */
export function buildV2Advertisement(): Buffer {
  const lines: PktItem[] = [
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(lines);
}

// ---- v2 ls-refs ---------------------------------------------------------------

export function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: PktItem[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (keep('HEAD')) {
    if (headTip === null) {
      if (unborn) {
        lines.push(
          `unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`,
        );
      }
    } else {
      lines.push(
        `${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`,
      );
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) line += ` peeled:${target}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---- v2 request parsing -------------------------------------------------------

/** Parse a v2 upload-pack body: `command=...`, then (past the delim) the arguments. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === '') {
      if (!text.startsWith('command=')) throw new Error('v2 request has no command');
      command = text.slice('command='.length);
    } else if (afterDelim) {
      args.push(text);
    }
    // Lines before the delim (agent=, object-format=) are ignored.
  }
  if (!command) throw new Error('v2 request has no command');
  return { command, args };
}

/** Parse a v0 upload-pack fetch body (wants section, then haves section). */
export function parseV0FetchRequest(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
      else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = parseInt(text.slice(7), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    }
    // 'done' and anything else in section 1 is ignored.
  }
  return { wants, haves, oldShallow: shallow, depth };
}

/** The fetch arguments, from either a v2 or a v0 request. */
export interface FetchRequest {
  wants: string[];
  haves: string[];
  oldShallow: string[];
  depth: number | null;
}

export function fetchRequestFromV2Args(args: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7), 10);
      if (Number.isFinite(n)) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action needed.
  }
  return { wants, haves, oldShallow: shallow, depth };
}

// ---- fetch planning ------------------------------------------------------------

/** Add a tree and everything under it to a set (trees and blobs). */
function addTreeObjects(forge: Forge, repo: Repo, treeSha: string, set: Set<string>): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (set.has(sha)) continue;
    const obj = forge.getObject(repo, sha);
    if (!obj) continue;
    set.add(sha);
    if (obj.type === 'tree') {
      const entries = forge.parseTree(repo, sha);
      if (entries) for (const entry of entries) stack.push(entry.sha);
    }
  }
}

export interface FetchPlan {
  objects: PackObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out which objects a fetch must deliver.
 *
 * Exclusion set: what the client is known to hold — everything reachable from the
 * haves, stopping below the old shallow boundaries (their parents are not held).
 * With a depth limit, commits within `depth` generations of a want are delivered
 * even when they sit below a held commit (that is how a deepen works); without one,
 * the exclusion set decides everything (incremental fetch / nothing-new).
 */
export function computeFetch(forge: Forge, repo: Repo, req: FetchRequest): FetchPlan {
  const exclusion = new Set<string>();
  {
    const stack = [...req.haves];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = forge.getObject(repo, sha);
      if (!obj) continue;
      exclusion.add(sha);
      if (obj.type === 'commit') {
        const info = forge.parseCommit(repo, sha);
        if (!info) continue;
        addTreeObjects(forge, repo, info.tree, exclusion);
        if (req.oldShallow.includes(sha)) continue;
        for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        addTreeObjects(forge, repo, sha, exclusion);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      }
    }
  }

  const included = new Map<string, PackObject>();
  const includedCommits = new Set<string>();
  const newShallow = new Set<string>();

  const addObject = (sha: string): void => {
    if (exclusion.has(sha) || included.has(sha)) return;
    const obj = forge.getObject(repo, sha);
    if (!obj) return;
    included.set(sha, { type: obj.type, data: obj.data, sha });
  };

  const addCommitTree = (sha: string): void => {
    const info = forge.parseCommit(repo, sha);
    if (!info) return;
    addObject(sha);
    const stack = [info.tree];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (exclusion.has(current) || included.has(current)) continue;
      const obj = forge.getObject(repo, current);
      if (!obj) continue;
      included.set(current, { type: obj.type, data: obj.data, sha: current });
      if (obj.type === 'tree') {
        const entries = forge.parseTree(repo, current);
        if (entries) for (const entry of entries) stack.push(entry.sha);
      }
    }
  };

  const visitCommit = (sha: string, gen: number): void => {
    const info = forge.parseCommit(repo, sha);
    if (!info) return;
    if (req.depth !== null && gen >= req.depth) return;
    if (exclusion.has(sha)) {
      // Held: not sent, but with a depth limit the walk continues below it (deepen).
      if (req.depth !== null) {
        for (const parent of info.parents) visitCommit(parent, gen + 1);
      }
      return;
    }
    includedCommits.add(sha);
    addCommitTree(sha);
    if (req.depth !== null && gen === req.depth - 1) {
      if (info.parents.length > 0 && info.parents.some((parent) => !exclusion.has(parent))) {
        newShallow.add(sha);
      }
      return;
    }
    for (const parent of info.parents) visitCommit(parent, gen + 1);
  };

  for (const want of req.wants) {
    const obj = forge.getObject(repo, want);
    if (!obj) continue;
    if (obj.type === 'commit') {
      visitCommit(want, 0);
    } else if (obj.type === 'tag') {
      addObject(want);
      const target = parseTagTarget(obj.data);
      if (target) {
        const targetObj = forge.getObject(repo, target);
        if (targetObj?.type === 'commit') visitCommit(target, 0);
        else if (target) addObject(target);
      }
    } else {
      addObject(want);
    }
  }

  const unshallow: string[] = [];
  for (const old of req.oldShallow) {
    const info = forge.parseCommit(repo, old);
    if (!info) continue;
    if (info.parents.length === 0) {
      unshallow.push(old);
      continue;
    }
    const stillBoundary = info.parents.some(
      (parent) => !includedCommits.has(parent) && !exclusion.has(parent),
    );
    if (!stillBoundary) unshallow.push(old);
  }

  const objects = [...included.values()].sort((a, b) =>
    a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0,
  );
  return { objects, shallow: [...newShallow].sort(), unshallow: unshallow.sort() };
}

/** Haves that are ancestors of (or equal to) a want: the ones the server ACKs. */
function ackedHaves(forge: Forge, repo: Repo, req: FetchRequest): string[] {
  return req.haves.filter((have) =>
    req.wants.some((want) => forge.isAncestor(repo, have, want)),
  );
}

/** Split pack bytes into sideband band-1 pkt-lines (band byte + at most 65515 data bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  return parts;
}

function fetchCacheKey(version: number, req: FetchRequest): string {
  return [
    version,
    req.wants.join(','),
    req.haves.join(','),
    req.oldShallow.join(','),
    req.depth === null ? '' : String(req.depth),
  ].join('|');
}

/** The v2 fetch response: acknowledgments, shallow-info, packfile (sideband). */
export function buildV2FetchResponse(forge: Forge, repo: Repo, req: FetchRequest): Buffer {
  const key = `v2|${fetchCacheKey(repo.version, req)}`;
  const cached = repo.fetchCache.get(key);
  if (cached) return cached;
  const plan = computeFetch(forge, repo, req);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const acked = ackedHaves(forge, repo, req);
  if (acked.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.fetchCache.set(key, out);
  return out;
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, then the sideband pack. */
export function buildV0FetchResponse(forge: Forge, repo: Repo, req: FetchRequest): Buffer {
  const plan = computeFetch(forge, repo, req);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  const acked = ackedHaves(forge, repo, req);
  if (acked.length === 0) parts.push(pktLine('NAK\n'));
  else for (const have of acked) parts.push(pktLine(`ACK ${have}\n`));
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---- receive-pack -------------------------------------------------------------

function applyPushCommand(
  forge: Forge,
  repo: Repo,
  cmd: { oldOid: string; newOid: string; ref: string },
): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = cmd;
  if (!ref.startsWith('refs/')) return { ref, ok: false, reason: 'invalid ref' };
  if (oldOid === ZERO_OID && newOid === ZERO_OID) {
    return { ref, ok: false, reason: 'invalid command' };
  }
  const current = repo.refs.get(ref);
  const bump = (): void => {
    repo.version += 1;
    repo.fetchCache.clear();
  };
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'ref does not exist' };
    repo.refs.delete(ref);
    bump();
    return { ref, ok: true, reason: '' };
  }
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    const obj = forge.getObject(repo, newOid);
    if (!obj) return { ref, ok: false, reason: 'object not found' };
    if (ref.startsWith('refs/heads/') && obj.type !== 'commit' && obj.type !== 'tag') {
      return { ref, ok: false, reason: 'object is not a commit' };
    }
    repo.refs.set(ref, newOid);
    bump();
    return { ref, ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ref, ok: false, reason: 'ref does not exist' };
  if (current !== oldOid) return { ref, ok: false, reason: 'old value does not match' };
  if (newOid === oldOid) return { ref, ok: true, reason: '' };
  const obj = forge.getObject(repo, newOid);
  if (!obj) return { ref, ok: false, reason: 'object not found' };
  if (obj.type !== 'commit' && obj.type !== 'tag') {
    return { ref, ok: false, reason: 'object is not a commit' };
  }
  if (!forge.isAncestor(repo, oldOid, newOid)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  bump();
  return { ref, ok: true, reason: '' };
}

/**
 * Handle a receive-pack POST: pkt-line commands, a flush, then the raw pack.
 * Answers the report-status stream (pkt-lined inside sideband band 1 when the
 * client asked for side-band-64k), one `ok`/`ng` line per command, in order.
 */
export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = splitCommandsAndPack(body);
  let sideband = false;
  const parsed: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let unpackError: string | null = null;
  for (const line of commands) {
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1).trim().split(/\s+/);
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const text = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
    if (!text) continue;
    const parts = text.split(' ');
    if (parts.length < 3 || !/^[0-9a-f]{40}$/.test(parts[0]) || !/^[0-9a-f]{40}$/.test(parts[1])) {
      unpackError = 'bad command line';
      break;
    }
    parsed.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  if (parsed.length === 0 && !unpackError) unpackError = 'no commands';
  if (!unpackError && pack.length > 0) {
    try {
      for (const obj of parsePack(pack)) forge.putObject(repo, obj.type, obj.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError) {
    for (const cmd of parsed) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const cmd of parsed) results.push(applyPushCommand(forge, repo, cmd));
  }
  const reportLines: string[] = [
    unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n',
  ];
  for (const result of results) {
    reportLines.push(
      result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`,
    );
  }
  if (sideband) {
    const parts: Buffer[] = [];
    for (const line of reportLines) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(line)])));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  return Buffer.concat([encodePktLines(reportLines), pktFlush()]);
}
