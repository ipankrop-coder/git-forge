// src/graphql.ts — GitHub GraphQL v4: a small parser + executor over the forge store.
//
// The documents the suite sends are the ones `gh` and `github-mcp-server` send
// (query ViewerLogin, repository fields, __type probes, issue/PR lists and reads,
// the five mutations, node(id:), batched operations). The executor resolves them
// against the same store REST uses, so the two surfaces always agree. Unknown
// fields are a 200 with an `errors` array naming the field; an unknown repository
// is `data.repository = null` with no errors; an unauthenticated request is a 401
// (enforced by the HTTP layer, not here).

import {
  Forge,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  createIssueRecord,
  createPullRecord,
  diffFiles,
  gid,
  mergeConflict,
  parseGid,
  squashMerge,
} from './store.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';

// ---- parser --------------------------------------------------------------------

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}
export interface SpreadNode {
  kind: 'spread';
  name: string;
}
export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}
export type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}
export interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}
export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or a plain "..." string.
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&()...:=@[]{|}'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
    return token.value;
  }

  private optionalPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.optionalPunct('(')) this.skipVariableDefinitions();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error('expected an operation or fragment in GraphQL document');
    }
    return { operations, fragments };
  }

  /** Skip `($var: Type = default, ...)` — the values arrive in the variables JSON. */
  private skipVariableDefinitions(): void {
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        return { kind: 'spread', name: this.expectName() };
      }
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.optionalPunct('(')) {
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  /** Directives are parsed and discarded (the suite sends none that change a result). */
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.optionalPunct('(')) {
        while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

/** Resolve a parsed value against the operation's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = resolveValue(child, variables);
      return out;
    }
  }
}

// ---- schema (drives introspection and field validation) -------------------------

interface SchemaField {
  type: string;
  args?: Record<string, string>;
}
interface SchemaType {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'UNION' | 'SCALAR' | 'INPUT_OBJECT';
  fields?: Record<string, SchemaField>;
  enumValues?: string[];
  possibleTypes?: string[];
  inputFields?: Record<string, SchemaField>;
}

const SCHEMA: Record<string, SchemaType> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository', args: { owner: 'String', name: 'String' } },
      node: { type: 'Node', args: { id: 'ID' } },
      search: { type: 'SearchResultItemConnection', args: { query: 'String', type: 'SearchType', first: 'Int', after: 'String' } },
      __type: { type: '__Type', args: { name: 'String' } },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput' } },
    },
  },
  Node: {
    kind: 'INTERFACE',
    fields: { id: { type: 'ID' } },
    possibleTypes: ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'],
  },
  Actor: {
    kind: 'INTERFACE',
    fields: { login: { type: 'String' } },
    possibleTypes: ['User'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      name: { type: 'String' },
      nameWithOwner: { type: 'String' },
      owner: { type: 'User' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean' },
      url: { type: 'URI' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      issue: { type: 'Issue', args: { number: 'Int' } },
      issues: { type: 'IssueConnection', args: { first: 'Int', after: 'String', states: '[IssueState]', orderBy: 'IssueOrder' } },
      pullRequests: { type: 'PullRequestConnection', args: { first: 'Int', after: 'String', states: '[PullRequestState]', orderBy: 'IssueOrder' } },
      pullRequest: { type: 'PullRequest', args: { number: 'Int' } },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      number: { type: 'Int' },
      title: { type: 'String' },
      body: { type: 'String' },
      state: { type: 'IssueState' },
      author: { type: 'Actor' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      closedAt: { type: 'DateTime' },
      url: { type: 'URI' },
      repository: { type: 'Repository' },
      labels: { type: 'LabelConnection', args: { first: 'Int', after: 'String' } },
      comments: { type: 'IssueCommentConnection', args: { first: 'Int', after: 'String' } },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      number: { type: 'Int' },
      title: { type: 'String' },
      body: { type: 'String' },
      state: { type: 'PullRequestState' },
      merged: { type: 'Boolean' },
      mergeable: { type: 'MergeableState' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      headRefOid: { type: 'String' },
      baseRefOid: { type: 'String' },
      author: { type: 'Actor' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      url: { type: 'URI' },
      repository: { type: 'Repository' },
      files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int', after: 'String' } },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      totalCount: { type: 'Int' },
      pageInfo: { type: 'PageInfo' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      totalCount: { type: 'Int' },
      pageInfo: { type: 'PageInfo' },
    },
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[SearchResultItem]' },
      edges: { type: '[SearchResultItemEdge]' },
      totalCount: { type: 'Int' },
      pageInfo: { type: 'PageInfo' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String' } } },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String' } } },
  SearchResultItemEdge: { kind: 'OBJECT', fields: { node: { type: 'SearchResultItem' }, cursor: { type: 'String' } } },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean' },
      hasPreviousPage: { type: 'Boolean' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      login: { type: 'String' },
      name: { type: 'String' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: { name: { type: 'String' }, target: { type: 'Commit' } },
  },
  Commit: {
    kind: 'OBJECT',
    fields: { oid: { type: 'String' }, message: { type: 'String' }, abbreviatedOid: { type: 'String' } },
  },
  Label: {
    kind: 'OBJECT',
    fields: { id: { type: 'ID' }, name: { type: 'String' }, color: { type: 'String' } },
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Label]' },
      edges: { type: '[LabelEdge]' },
      totalCount: { type: 'Int' },
      pageInfo: { type: 'PageInfo' },
    },
  },
  LabelEdge: { kind: 'OBJECT', fields: { node: { type: 'Label' }, cursor: { type: 'String' } } },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      body: { type: 'String' },
      author: { type: 'Actor' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      url: { type: 'URI' },
    },
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[IssueComment]' },
      edges: { type: '[IssueCommentEdge]' },
      totalCount: { type: 'Int' },
      pageInfo: { type: 'PageInfo' },
    },
  },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String' } } },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String' },
      additions: { type: 'Int' },
      deletions: { type: 'Int' },
      changeType: { type: 'String' },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      edges: { type: '[PullRequestChangedFileEdge]' },
      totalCount: { type: 'Int' },
      pageInfo: { type: 'PageInfo' },
    },
  },
  PullRequestChangedFileEdge: {
    kind: 'OBJECT',
    fields: { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String' } },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'IssueCommentEdge' },
      subject: { type: 'Issue' },
      clientMutationId: { type: 'String' },
    },
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: { type: 'ID' },
      title: { type: 'String' },
      body: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      issueId: { type: 'ID' },
      stateReason: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: { type: 'ID' },
      title: { type: 'String' },
      body: { type: 'String' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      pullRequestId: { type: 'ID' },
      mergeMethod: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      subjectId: { type: 'ID' },
      body: { type: 'String' },
      clientMutationId: { type: 'String' },
    },
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: { field: { type: 'IssueOrderField' }, direction: { type: 'OrderDirection' } },
  },
  SearchResultItem: {
    kind: 'UNION',
    possibleTypes: ['Issue', 'PullRequest', 'Repository'],
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '[__Type]' },
      queryType: { type: '__Type' },
      mutationType: { type: '__Type' },
      description: { type: 'String' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: '__TypeKind' },
      description: { type: 'String' },
      fields: { type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
      possibleTypes: { type: '[__Type]' },
      inputFields: { type: '[__InputValue]' },
      interfaces: { type: '[__Type]' },
      ofType: { type: '__Type' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      args: { type: '[__InputValue]' },
      type: { type: '__Type' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      type: { type: '__Type' },
      defaultValue: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      locations: { type: '[String]' },
      args: { type: '[__InputValue]' },
    },
  },
  __TypeKind: {
    kind: 'ENUM',
    enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
};

// ---- values ---------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function userValue(): AnyObj {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME };
}

function repoValue(forge: Forge, repo: Repo): AnyObj {
  return { __typename: 'Repository', forge, repo };
}

function issueValue(forge: Forge, repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', forge, repo, issue };
}

function pullValue(forge: Forge, repo: Repo, pr: PullRequest): AnyObj {
  return { __typename: 'PullRequest', forge, repo, pr };
}

function commentValue(forge: Forge, repo: Repo, issue: Issue, comment: { id: number; body: string; user: string; created_at: string }): AnyObj {
  return { __typename: 'IssueComment', forge, repo, issue, comment };
}

// ---- cursors + connections ---------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function paginate(
  items: readonly AnyObj[],
  args: Record<string, unknown>,
  edgeType: string,
  connType: string,
): AnyObj {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after) {
    const index = decodeCursor(args.after);
    if (index !== null) start = index + 1;
  }
  const page = items.slice(start, start + first);
  return {
    __typename: connType,
    nodes: page,
    edges: page.map((node, i) => ({ __typename: edgeType, node, cursor: encodeCursor(start + i) })),
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(start) : null,
      endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
    },
  };
}

// ---- id lookups ---------------------------------------------------------------------

function findRepoById(forge: Forge, id: unknown): Repo | null {
  if (typeof id === 'number') {
    for (const repo of forge.listRepos()) if (repo.id === id) return repo;
    return null;
  }
  if (typeof id === 'string') {
    const parsed = parseGid(id);
    if (parsed && parsed.kind === 'Repository') {
      for (const repo of forge.listRepos()) if (repo.id === parsed.repoId) return repo;
    }
  }
  return null;
}

function findIssueById(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'Issue' || parsed.num === undefined) return null;
  for (const repo of forge.listRepos()) {
    if (repo.id !== parsed.repoId) continue;
    const issue = repo.issues.get(parsed.num);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullById(forge: Forge, id: unknown): { repo: Repo; pr: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'PullRequest' || parsed.num === undefined) return null;
  for (const repo of forge.listRepos()) {
    if (repo.id !== parsed.repoId) continue;
    const pr = repo.pulls.get(parsed.num);
    if (pr) return { repo, pr };
  }
  return null;
}

// ---- resolvers --------------------------------------------------------------------

type Resolver = (parent: AnyObj, args: Record<string, unknown>, forge: Forge) => unknown;

function issueList(parent: AnyObj, args: Record<string, unknown>): AnyObj {
  const { repo, forge } = parent;
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  list.sort((a, b) => (a.createdSeq < b.createdSeq ? -1 : a.createdSeq > b.createdSeq ? 1 : 0));
  if (orderBy && (orderBy.direction ?? 'ASC') === 'DESC') list.reverse();
  return paginate(
    list.map((issue) => issueValue(forge, repo, issue)),
    args,
    'IssueEdge',
    'IssueConnection',
  );
}

function pullList(parent: AnyObj, args: Record<string, unknown>): AnyObj {
  const { repo, forge } = parent;
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((pr) =>
      states.includes(pr.merged ? 'MERGED' : pr.state.toUpperCase()),
    );
  } else {
    list = list.filter((pr) => pr.state === 'open');
  }
  // GitHub's default list order is newest first.
  list.sort((a, b) => (a.createdSeq < b.createdSeq ? 1 : a.createdSeq > b.createdSeq ? -1 : 0));
  return paginate(
    list.map((pr) => pullValue(forge, repo, pr)),
    args,
    'PullRequestEdge',
    'PullRequestConnection',
  );
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userValue(),
    repository: (_parent, args, forge) => {
      const repo = forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoValue(forge, repo) : null;
    },
    node: (_parent, args, forge) => {
      const parsed = parseGid(String(args.id ?? ''));
      if (!parsed) return null;
      for (const repo of forge.listRepos()) {
        if (repo.id !== parsed.repoId) continue;
        if (parsed.kind === 'Repository') return repoValue(forge, repo);
        if (parsed.kind === 'Issue' && parsed.num !== undefined) {
          const issue = repo.issues.get(parsed.num);
          if (issue) return issueValue(forge, repo, issue);
        }
        if (parsed.kind === 'PullRequest' && parsed.num !== undefined) {
          const pr = repo.pulls.get(parsed.num);
          if (pr) return pullValue(forge, repo, pr);
        }
      }
      return null;
    },
    search: (_parent, args, forge) => {
      const query = typeof args.query === 'string' ? args.query : '';
      const repoMatch = /repo:([^\s]+)/.exec(query);
      let issues: AnyObj[] = [];
      for (const repo of forge.listRepos()) {
        if (repoMatch) {
          const [owner, name] = repoMatch[1].split('/');
          if (name && (repo.owner !== owner || repo.name !== name)) continue;
        }
        for (const issue of repo.issues.values()) issues.push(issueValue(forge, repo, issue));
      }
      issues.sort((a, b) => (a.issue.createdSeq < b.issue.createdSeq ? -1 : 1));
      return paginate(issues, args, 'SearchResultItemEdge', 'SearchResultItemConnection');
    },
    __type: (_parent, args) => {
      const name = String(args.name ?? '');
      const def = SCHEMA[name];
      if (!def) return null;
      return { __typename: '__Type', ref: { kind: def.kind, name } };
    },
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_parent, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(forge, input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (!title) throw new Error('title is required');
      const issue = createIssueRecord(forge, repo, title, typeof input.body === 'string' ? input.body : '', []);
      return {
        __typename: 'CreateIssuePayload',
        issue: issueValue(forge, repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    closeIssue: (_parent, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(forge, input.issueId);
      if (!found) throw new Error('issue not found');
      const { repo, issue } = found;
      issue.state = 'closed';
      issue.closed_at = forge.nowIso();
      issue.updated_at = forge.nowIso();
      repo.issueJson.delete(issue.number);
      return {
        __typename: 'CloseIssuePayload',
        issue: issueValue(forge, repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    createPullRequest: (_parent, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoById(forge, input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      if (!title || !headRef) throw new Error('title and headRefName are required');
      const headSha = forge.branchTip(repo, headRef);
      if (headSha === null) throw new Error('head branch does not exist');
      const baseSha = forge.branchTip(repo, baseRef);
      if (baseSha === null) throw new Error('base branch does not exist');
      const pr = createPullRecord(
        forge,
        repo,
        title,
        typeof input.body === 'string' ? input.body : '',
        headRef,
        headSha,
        baseRef,
        baseSha,
      );
      pr.mergeable = !mergeConflict(forge, repo, baseSha, headSha);
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullValue(forge, repo, pr),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    mergePullRequest: (_parent, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullById(forge, input.pullRequestId);
      if (!found) throw new Error('pull request not found');
      const { repo, pr } = found;
      const result = squashMerge(forge, repo, pr);
      if ('error' in result) throw new Error(result.error);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullValue(forge, repo, pr),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
    addComment: (_parent, args, forge) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueById(forge, input.subjectId);
      if (!found) throw new Error('issue not found');
      const { repo, issue } = found;
      const body = typeof input.body === 'string' ? input.body : '';
      if (!body) throw new Error('body is required');
      const comment = {
        id: forge.nextCommentIdValue(),
        body,
        user: VIEWER_LOGIN,
        created_at: forge.nowIso(),
      };
      issue.comments.push(comment);
      repo.issueJson.delete(issue.number);
      const node = commentValue(forge, repo, issue, comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(issue.comments.length - 1) },
        subject: issueValue(forge, repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      };
    },
  },
  Repository: {
    id: (p) => gid('Repository', p.repo.id),
    databaseId: (p) => p.repo.id,
    name: (p) => p.repo.name,
    nameWithOwner: (p) => p.repo.fullName,
    owner: () => userValue(),
    description: (p) => p.repo.description,
    isPrivate: (p) => p.repo.private,
    defaultBranchRef: (p) => {
      const tip = p.forge.branchTip(p.repo, p.repo.defaultBranch);
      return tip
        ? { __typename: 'Ref', name: p.repo.defaultBranch, oid: tip, forge: p.forge, repo: p.repo }
        : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (p) => `https://github.com/${p.repo.fullName}`,
    createdAt: (p) => p.repo.created_at,
    updatedAt: (p) => p.repo.updated_at,
    issue: (p, args) => {
      const issue = p.repo.issues.get(Number(args.number));
      return issue ? issueValue(p.forge, p.repo, issue) : null;
    },
    issues: (p, args) => issueList(p, args),
    pullRequests: (p, args) => pullList(p, args),
    pullRequest: (p, args) => {
      const pr = p.repo.pulls.get(Number(args.number));
      return pr ? pullValue(p.forge, p.repo, pr) : null;
    },
  },
  Issue: {
    id: (p) => gid('Issue', p.repo.id, p.issue.number),
    databaseId: (p) => p.issue.id,
    number: (p) => p.issue.number,
    title: (p) => p.issue.title,
    body: (p) => p.issue.body,
    state: (p) => p.issue.state.toUpperCase(),
    author: () => userValue(),
    createdAt: (p) => p.issue.created_at,
    updatedAt: (p) => p.issue.updated_at,
    closedAt: (p) => p.issue.closed_at,
    url: (p) => `https://github.com/${p.repo.fullName}/issues/${p.issue.number}`,
    repository: (p) => repoValue(p.forge, p.repo),
    labels: (p, args) =>
      paginate(
        p.issue.labels.map((label: Label) => ({ __typename: 'Label', label, repo: p.repo })),
        args,
        'LabelEdge',
        'LabelConnection',
      ),
    comments: (p, args) =>
      paginate(
        p.issue.comments.map((comment: { id: number; body: string; user: string; created_at: string }) =>
          commentValue(p.forge, p.repo, p.issue, comment),
        ),
        args,
        'IssueCommentEdge',
        'IssueCommentConnection',
      ),
  },
  PullRequest: {
    id: (p) => gid('PullRequest', p.repo.id, p.pr.number),
    databaseId: (p) => p.pr.id,
    number: (p) => p.pr.number,
    title: (p) => p.pr.title,
    body: (p) => p.pr.body,
    state: (p) => (p.pr.merged ? 'MERGED' : p.pr.state.toUpperCase()),
    merged: (p) => p.pr.merged,
    mergeable: (p) => {
      if (p.pr.merged) return 'UNKNOWN';
      const baseTip = p.forge.branchTip(p.repo, p.pr.baseRef);
      if (baseTip === null) return 'UNKNOWN';
      return mergeConflict(p.forge, p.repo, baseTip, p.pr.headSha) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (p) => p.pr.headRef,
    baseRefName: (p) => p.pr.baseRef,
    headRefOid: (p) => p.pr.headSha,
    baseRefOid: (p) => p.pr.baseSha,
    author: () => userValue(),
    createdAt: (p) => p.pr.created_at,
    updatedAt: (p) => p.pr.updated_at,
    url: (p) => `https://github.com/${p.repo.fullName}/pull/${p.pr.number}`,
    repository: (p) => repoValue(p.forge, p.repo),
    files: (p, args) => {
      const { forge, repo, pr } = p;
      const headInfo = forge.parseCommit(repo, pr.headSha);
      if (!headInfo) return paginate([], args, 'PullRequestChangedFileEdge', 'PullRequestChangedFileConnection');
      const mb = forge.mergeBase(repo, pr.baseSha, pr.headSha);
      const mbInfo = mb ? forge.parseCommit(repo, mb) : null;
      const baseInfo = forge.parseCommit(repo, pr.baseSha);
      const baseTree = mbInfo ? mbInfo.tree : baseInfo ? baseInfo.tree : null;
      const changes = diffFiles(forge, repo, baseTree, headInfo.tree);
      const nodes = changes.map((change) => ({
        __typename: 'PullRequestChangedFile',
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return paginate(nodes, args, 'PullRequestChangedFileEdge', 'PullRequestChangedFileConnection');
    },
  },
  User: {
    id: () => gid('User', VIEWER_ID),
    databaseId: () => VIEWER_ID,
    login: (p) => p.login,
    name: (p) => p.name,
  },
  Ref: {
    name: (p) => p.name,
    target: (p) => {
      const info = p.forge.parseCommit(p.repo, p.oid);
      return { __typename: 'Commit', oid: p.oid, message: info ? info.message : '' };
    },
  },
  Commit: {
    oid: (p) => p.oid,
    message: (p) => p.message,
    abbreviatedOid: (p) => p.oid.slice(0, 7),
  },
  Label: {
    id: (p) => Buffer.from(`Label:${p.repo.id}:${p.label.name}`, 'utf8').toString('base64url'),
    name: (p) => p.label.name,
    color: (p) => p.label.color,
  },
  IssueComment: {
    id: (p) => gid('IssueComment', p.repo.id, p.comment.id),
    databaseId: (p) => p.comment.id,
    body: (p) => p.comment.body,
    author: () => userValue(),
    createdAt: (p) => p.comment.created_at,
    updatedAt: (p) => p.comment.created_at,
    url: (p) => `https://github.com/${p.repo.fullName}/issues/${p.issue.number}#issuecomment-${p.comment.id}`,
  },
  PullRequestChangedFile: {
    path: (p) => p.path,
    additions: (p) => p.additions,
    deletions: (p) => p.deletions,
    changeType: (p) => p.changeType,
  },
  __Schema: {
    types: () =>
      Object.keys(SCHEMA).map((name) => ({
        __typename: '__Type',
        ref: { kind: SCHEMA[name].kind, name },
      })),
    queryType: () => ({ __typename: '__Type', ref: { kind: 'OBJECT', name: 'Query' } }),
    mutationType: () => ({ __typename: '__Type', ref: { kind: 'OBJECT', name: 'Mutation' } }),
    description: () => null,
  },
  __Type: {
    name: (p) => p.ref.name ?? null,
    kind: (p) => p.ref.kind,
    description: () => null,
    fields: (p) => {
      const def = p.ref.name ? SCHEMA[p.ref.name] : undefined;
      if (!def || !def.fields) return null;
      return Object.entries(def.fields).map(([name, field]) => ({
        __typename: '__Field',
        name,
        typeRef: field.type,
        args: Object.entries(field.args ?? {}).map(([argName, argType]) => ({
          __typename: '__InputValue',
          name: argName,
          typeRef: argType,
        })),
      }));
    },
    enumValues: (p) => {
      const def = p.ref.name ? SCHEMA[p.ref.name] : undefined;
      if (!def || !def.enumValues) return null;
      return def.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
    },
    possibleTypes: (p) => {
      const def = p.ref.name ? SCHEMA[p.ref.name] : undefined;
      if (!def || !def.possibleTypes) return null;
      return def.possibleTypes.map((name) => ({
        __typename: '__Type',
        ref: { kind: SCHEMA[name]?.kind ?? 'OBJECT', name },
      }));
    },
    inputFields: (p) => {
      const def = p.ref.name ? SCHEMA[p.ref.name] : undefined;
      if (!def || !def.inputFields) return null;
      return Object.entries(def.inputFields).map(([name, field]) => ({
        __typename: '__InputValue',
        name,
        typeRef: field.type,
      }));
    },
    interfaces: (p) => {
      const name = p.ref.name;
      if (!name) return null;
      const out: AnyObj[] = [];
      if (name === 'Repository' || name === 'Issue' || name === 'PullRequest' || name === 'User' || name === 'IssueComment') {
        out.push({ __typename: '__Type', ref: { kind: 'INTERFACE', name: 'Node' } });
      }
      if (name === 'User') out.push({ __typename: '__Type', ref: { kind: 'INTERFACE', name: 'Actor' } });
      return out;
    },
    ofType: (p) => (p.ref.ofType ? { __typename: '__Type', ref: p.ref.ofType } : null),
  },
  __Field: {
    name: (p) => p.name,
    description: () => null,
    args: (p) => p.args ?? [],
    type: (p) => ({ __typename: '__Type', ref: parseTypeRef(p.typeRef) }),
  },
  __InputValue: {
    name: (p) => p.name,
    description: () => null,
    type: (p) => ({ __typename: '__Type', ref: parseTypeRef(p.typeRef) }),
    defaultValue: () => null,
  },
  __EnumValue: {
    name: (p) => p.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

/** Parse a schema type string ('String', '[Issue!]!', 'IssueConnection') into a __Type ref. */
function parseTypeRef(type: string): { kind: string; name?: string; ofType?: unknown } {
  if (type.endsWith('!')) return { kind: 'NON_NULL', ofType: parseTypeRef(type.slice(0, -1)) };
  if (type.startsWith('[') && type.endsWith(']')) {
    return { kind: 'LIST', ofType: parseTypeRef(type.slice(1, -1)) };
  }
  const def = SCHEMA[type];
  return { kind: def ? def.kind : 'SCALAR', name: type };
}

// ---- executor ---------------------------------------------------------------------

interface GqlCtx {
  forge: Forge;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
}

/** The named type of a schema type string ('[Issue!]!' -> 'Issue'). */
function namedTypeOf(type: string): string {
  let current = type;
  while (current.endsWith('!')) current = current.slice(0, -1);
  while (current.startsWith('[') && current.endsWith(']')) current = current.slice(1, -1);
  while (current.endsWith('!')) current = current.slice(0, -1);
  return current;
}

const IMPLEMENTS: Record<string, string[]> = {
  Repository: ['Node'],
  Issue: ['Node'],
  PullRequest: ['Node'],
  User: ['Node', 'Actor'],
  IssueComment: ['Node'],
};

function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  return (IMPLEMENTS[actual] ?? []).includes(condition);
}

function resolveField(parent: AnyObj, parentType: string, name: string, args: Record<string, unknown>, forge: Forge): unknown {
  const byType = RESOLVERS[parentType];
  const resolver = byType?.[name];
  if (resolver) return resolver(parent, args, forge);
  // Default: a plain property on the parent value (connections, edges, pageInfo).
  if (parent !== null && typeof parent === 'object' && name in parent) return parent[name];
  return null;
}

function applySelections(value: unknown, typeName: string, selections: SelectionNode[], ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => applySelections(item, typeName, selections, ctx));
  }
  if (typeof value === 'object') {
    const actualType = (value as AnyObj).__typename ?? typeName;
    return executeSelection(value as AnyObj, actualType, selections, ctx);
  }
  return value;
}

function executeField(parent: AnyObj, parentType: string, field: FieldNode, ctx: GqlCtx): unknown {
  const name = field.name;
  if (name === '__typename') return parentType;
  const typeDef = SCHEMA[parentType];
  const fieldDef = typeDef?.fields?.[name];
  if (!fieldDef) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const [argName, valueNode] of Object.entries(field.args)) {
    args[argName] = resolveValue(valueNode, ctx.variables);
  }
  let value: unknown;
  try {
    value = resolveField(parent, parentType, name, args, ctx.forge);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (field.selections === null) return value;
  return applySelections(value, namedTypeOf(fieldDef.type), field.selections, ctx);
}

function executeSelection(parent: AnyObj, parentType: string, selections: SelectionNode[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition && !typeMatches(parentType, fragment.typeCondition)) continue;
      Object.assign(out, executeSelection(parent, parentType, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && !typeMatches(parentType, selection.typeCondition)) continue;
      Object.assign(out, executeSelection(parent, parentType, selection.selections, ctx));
      continue;
    }
    out[selection.alias ?? selection.name] = executeField(parent, parentType, selection, ctx);
  }
  return out;
}

function executeOperation(
  forge: Forge,
  doc: DocumentNode,
  operationName: string | null,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((candidate) => candidate.name === operationName);
    if (!operation) {
      errors.push({ message: `Unknown operation named "${operationName}".` });
      return { data: null, errors };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    errors.push({ message: 'No operation provided.' });
    return { data: null, errors };
  } else {
    errors.push({ message: 'Must provide operation name if query contains multiple operations.' });
    return { data: null, errors };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const ctx: GqlCtx = { forge, errors, fragments: doc.fragments, variables };
  const root: AnyObj = { __typename: rootType };
  const data = executeSelection(root, rootType, operation.selections, ctx);
  return { data, errors };
}

// ---- HTTP entry point ---------------------------------------------------------------

/** Run one GraphQL request body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, bodyText: string): { status: number; json: string } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      json: JSON.stringify({ errors: [{ message: 'Request body is not valid JSON' }] }),
    };
  }
  const isBatch = Array.isArray(body);
  const operations = isBatch ? (body as unknown[]) : [body];
  const results = operations.map((operation) => {
    if (!operation || typeof operation !== 'object' || typeof (operation as AnyObj).query !== 'string') {
      return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    }
    const variables =
      (operation as AnyObj).variables !== null && typeof (operation as AnyObj).variables === 'object'
        ? ((operation as AnyObj).variables as Record<string, unknown>)
        : {};
    let doc: DocumentNode;
    try {
      doc = parseDocument((operation as AnyObj).query as string);
    } catch (err) {
      return {
        data: null,
        errors: [{ message: err instanceof Error ? err.message : 'Syntax error in GraphQL document' }],
      };
    }
    const operationName =
      typeof (operation as AnyObj).operationName === 'string'
        ? ((operation as AnyObj).operationName as string)
        : null;
    const result = executeOperation(forge, doc, operationName, variables);
    return result.errors.length > 0
      ? { data: result.data, errors: result.errors }
      : { data: result.data };
  });
  return { status: 200, json: JSON.stringify(isBatch ? results : results[0]) };
}
