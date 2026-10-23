import {
  NodeKind,
  SourceScope,
  VisualizationKind,
  type FavoriteContent,
  type QueryStatement,
  type SavedQuery,
  type Tree,
  type TreeNode,
} from '../../generated/explorer/user_storage_pb';
import {
  MAX_EXPRESSION_BYTES,
  MAX_NAME_LENGTH,
  MAX_QUERIES_PER_FAVORITE,
  MAX_STATEMENTS_PER_QUERY,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from './limits';

/** Names are compared and stored without surrounding blanks and in Unicode NFC; case still counts. */
export function normalizeName(name: string): string {
  return name.trim().normalize('NFC');
}

export function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) {
    length++;
  }
  return length;
}

const utf8 = new TextEncoder();

export function utf8Length(value: string): number {
  return utf8.encode(value).length;
}

/** Why a folder, favorite or query name cannot be saved, or null when it can. */
export function nameProblem(name: string): string | null {
  const normalized = normalizeName(name);
  if (normalized === '') {
    return 'Enter a name.';
  }
  const length = codePointLength(normalized);
  if (length > MAX_NAME_LENGTH) {
    return `Names are limited to ${MAX_NAME_LENGTH} characters (this one has ${length}).`;
  }
  return null;
}

/** Problems that keep one statement from being saved; empty when it can be. */
export function statementProblems(statement: QueryStatement): string[] {
  const problems: string[] = [];
  const expression = statement.expression.trim();
  if (expression === '') {
    problems.push('Enter an expression.');
  } else if (utf8Length(statement.expression) > MAX_EXPRESSION_BYTES) {
    problems.push(`Expressions are limited to ${MAX_EXPRESSION_BYTES / 1024} KiB.`);
  }
  if (
    statement.visualization === VisualizationKind.UNSPECIFIED ||
    VisualizationKind[statement.visualization] === undefined
  ) {
    problems.push('Choose a visualization.');
  }
  problems.push(...sourceProblems(statement));
  return problems;
}

function sourceProblems(statement: QueryStatement): string[] {
  switch (statement.sourceScope) {
    case SourceScope.UNSPECIFIED:
      return statement.sourceScopeValue !== '' || statement.sourceFilters.length > 0
        ? ['A statement without a browse source cannot carry its value or filters.']
        : [];
    case SourceScope.BY_POD:
    case SourceScope.BY_NODE:
      if (statement.sourceScopeValue === '') {
        return ['The browse source is missing its pod prefix or node.'];
      }
      break;
    case SourceScope.BY_NAME:
      break;
    default:
      return ['Unknown browse source.'];
  }
  const labels = new Set<string>();
  for (const filter of statement.sourceFilters) {
    if (labels.has(filter.name) || filter.values.length === 0 || new Set(filter.values).size !== filter.values.length) {
      return ['The browse source filters are inconsistent.'];
    }
    labels.add(filter.name);
  }
  return [];
}

/** Problems that keep one query from being saved; empty when it can be. */
export function queryProblems(query: SavedQuery): string[] {
  const problems: string[] = [];
  if (query.id === '') {
    problems.push('The query has no id.');
  }
  const name = nameProblem(query.name);
  if (name) {
    problems.push(name);
  }
  if (query.statements.length === 0) {
    problems.push('A query needs at least one statement.');
  } else if (query.statements.length > MAX_STATEMENTS_PER_QUERY) {
    problems.push(`A query holds at most ${MAX_STATEMENTS_PER_QUERY} statements.`);
  }
  query.statements.forEach((statement, index) => {
    for (const problem of statementProblems(statement)) {
      problems.push(`Statement ${index + 1}: ${problem}`);
    }
  });
  return problems;
}

/** Problems of a whole favorite's query list. */
export function queryListProblems(queries: SavedQuery[]): string[] {
  const problems: string[] = [];
  if (queries.length > MAX_QUERIES_PER_FAVORITE) {
    problems.push(`A favorite holds at most ${MAX_QUERIES_PER_FAVORITE} queries.`);
  }
  const ids = new Set<string>();
  queries.forEach((query, index) => {
    if (ids.has(query.id)) {
      problems.push(`Query ${index + 1} repeats the id of another query.`);
    }
    ids.add(query.id);
    for (const problem of queryProblems(query)) {
      problems.push(`${query.name || `Query ${index + 1}`}: ${problem}`);
    }
  });
  return problems;
}

export interface TreeCheck {
  /** Broken structure: the menu must not be written back. */
  structural: string[];
  /** Over a size limit: nothing may be added, but deletes and moves still work. */
  overLimit: string[];
}

/** Check a menu: ids, kinds, children, sibling names, depth and node count. */
export function checkTree(tree: Tree): TreeCheck {
  const structural: string[] = [];
  const overLimit: string[] = [];
  const ids = new Set<bigint>();
  let count = 0;

  const visit = (nodes: TreeNode[], depth: number) => {
    const names = new Set<string>();
    for (const node of nodes) {
      count++;
      const label = `“${node.name}” (id ${node.id})`;
      if (node.id === BigInt(0)) {
        structural.push(`${label} has no id.`);
      } else if (node.id > tree.maxTreeNodeId) {
        structural.push(`${label} is above the id counter ${tree.maxTreeNodeId}.`);
      }
      if (ids.has(node.id)) {
        structural.push(`Id ${node.id} is used more than once.`);
      }
      ids.add(node.id);
      if (node.kind !== NodeKind.FOLDER && node.kind !== NodeKind.FAVORITE) {
        structural.push(`${label} has an unknown kind ${node.kind}.`);
      }
      if (node.kind === NodeKind.FAVORITE && node.children.length > 0) {
        structural.push(`Favorite ${label} has children.`);
      }
      const name = normalizeName(node.name);
      if (nameProblem(node.name)) {
        structural.push(`${label}: ${nameProblem(node.name)}`);
      }
      if (names.has(name)) {
        structural.push(`Two entries in one folder are named “${name}”.`);
      }
      names.add(name);
      if (depth > MAX_TREE_DEPTH) {
        overLimit.push(`${label} is nested deeper than ${MAX_TREE_DEPTH} levels.`);
      }
      visit(node.children, depth + 1);
    }
  };
  visit(tree.children, 1);

  if (count > MAX_TREE_NODES) {
    overLimit.push(`The menu has ${count} entries; at most ${MAX_TREE_NODES} are allowed.`);
  }
  return { structural, overLimit };
}

/** Problems of a decoded favorite content read from the key of nodeId. */
export function contentProblems(content: FavoriteContent, nodeId: bigint): string[] {
  if (content.nodeId !== nodeId) {
    return [`The content belongs to id ${content.nodeId}, but is stored for id ${nodeId}.`];
  }
  return [];
}

// Grafana dashboard variables are not expanded by the Explorer backend (§8.1). Strings are blanked
// first so a regex matcher such as =~"api$" is not mistaken for a variable.
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g;
const TEMPLATE_VARIABLE = /\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/;

/** The first dashboard variable in an expression (e.g. $__rate_interval), or null. */
export function templateVariableIn(expression: string): string | null {
  const match = TEMPLATE_VARIABLE.exec(expression.replace(STRING_LITERAL, '""'));
  return match ? match[0] : null;
}
