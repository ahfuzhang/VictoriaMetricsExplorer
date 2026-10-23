/**
 * @jest-environment node
 */
import { create } from '@bufbuild/protobuf';

import { NodeKind, SavedQuerySchema, SourceScope, TreeNodeSchema } from '../../generated/explorer/user_storage_pb';
import {
  MAX_EXPRESSION_BYTES,
  MAX_NAME_LENGTH,
  MAX_STATEMENTS_PER_QUERY,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from './limits';
import { favorite, folder, query, statement, tree } from './testUtils';
import {
  checkTree,
  codePointLength,
  nameProblem,
  normalizeName,
  queryListProblems,
  queryProblems,
  statementProblems,
  templateVariableIn,
} from './validation';

describe('names', () => {
  it('trims, normalizes to NFC and keeps case', () => {
    expect(normalizeName('  café ')).toBe('café');
    expect(normalizeName('Api')).not.toBe(normalizeName('api'));
  });

  it('counts code points, so an emoji is one character', () => {
    expect(codePointLength('😀a')).toBe(2);
    expect(nameProblem('😀'.repeat(MAX_NAME_LENGTH))).toBeNull();
    expect(nameProblem('😀'.repeat(MAX_NAME_LENGTH + 1))).toContain(`${MAX_NAME_LENGTH}`);
    expect(nameProblem('   ')).toBe('Enter a name.');
  });
});

describe('statements and queries', () => {
  it('requires an expression within the backend limit, not a datasource', () => {
    expect(statementProblems(statement('up'))).toEqual([]);
    expect(statementProblems(statement('  '))).toEqual(['Enter an expression.']);
    expect(statementProblems(statement('é'.repeat(MAX_EXPRESSION_BYTES / 2 + 1)))[0]).toContain('KiB');
    // Statements run on the toolbar's datasource; the saved one is only a fallback.
    expect(statementProblems(statement('up', ''))).toEqual([]);
  });

  it('checks the browse source rules', () => {
    const byPod = statement();
    byPod.sourceScope = SourceScope.BY_POD;
    expect(statementProblems(byPod)).toEqual(['The browse source is missing its pod prefix or node.']);
    byPod.sourceScopeValue = 'api';
    expect(statementProblems(byPod)).toEqual([]);

    const allMetrics = statement();
    allMetrics.sourceScope = SourceScope.BY_NAME;
    expect(statementProblems(allMetrics)).toEqual([]);

    const handWritten = statement();
    handWritten.sourceFilters = [{ $typeName: 'explorer.userstorage.v1.SavedLabelFilter', name: 'job', values: ['a'] }];
    expect(statementProblems(handWritten)).toHaveLength(1);

    allMetrics.sourceFilters = [
      { $typeName: 'explorer.userstorage.v1.SavedLabelFilter', name: 'job', values: ['a', 'a'] },
    ];
    expect(statementProblems(allMetrics)).toHaveLength(1);
  });

  it('needs 1 to 10 statements and unique query ids', () => {
    expect(queryProblems(query('q'))).toEqual([]);
    expect(queryProblems(create(SavedQuerySchema, { id: 'q', name: 'q' }))).toContain(
      'A query needs at least one statement.'
    );
    const many = create(SavedQuerySchema, {
      id: 'q',
      name: 'q',
      statements: Array.from({ length: MAX_STATEMENTS_PER_QUERY + 1 }, () => statement()),
    });
    expect(queryProblems(many)).toContain(`A query holds at most ${MAX_STATEMENTS_PER_QUERY} statements.`);
    expect(queryListProblems([query('a'), query('a')])).toHaveLength(1);
  });
});

describe('template variables', () => {
  it('finds dashboard variables outside string literals only', () => {
    expect(templateVariableIn('rate(x[$__rate_interval])')).toBe('$__rate_interval');
    expect(templateVariableIn('up{job="$job"}')).toBeNull();
    expect(templateVariableIn('up{job=~"api$"}')).toBeNull();
    expect(templateVariableIn('sum by (${group}) (up)')).toBe('${group}');
    expect(templateVariableIn('sum(rate(x[5m]))')).toBeNull();
  });
});

describe('checkTree', () => {
  it('accepts a consistent menu', () => {
    expect(checkTree(tree(3, [folder(1, 'a', [favorite(2, 'b')]), favorite(3, 'c')]))).toEqual({
      structural: [],
      overLimit: [],
    });
  });

  it('reports broken structure', () => {
    const broken = tree(2, [folder(1, 'a'), folder(1, 'b'), favorite(3, 'c')]);
    broken.children.push(
      create(TreeNodeSchema, { id: BigInt(2), name: 'd', kind: NodeKind.FAVORITE, children: [favorite(0, 'e')] })
    );
    broken.children.push(create(TreeNodeSchema, { id: BigInt(2), name: 'a', kind: 7 as NodeKind }));
    const { structural } = checkTree(broken);
    expect(structural.join('\n')).toMatch(/used more than once/);
    expect(structural.join('\n')).toMatch(/above the id counter/);
    expect(structural.join('\n')).toMatch(/has children/);
    expect(structural.join('\n')).toMatch(/has no id/);
    expect(structural.join('\n')).toMatch(/unknown kind/);
    expect(structural.join('\n')).toMatch(/named “a”/);
  });

  it('reports size limits separately from structure', () => {
    let deep = folder(MAX_TREE_DEPTH + 1, 'x');
    for (let id = MAX_TREE_DEPTH; id >= 1; id--) {
      deep = folder(id, `d${id}`, [deep]);
    }
    expect(checkTree(tree(MAX_TREE_DEPTH + 1, [deep])).overLimit).toHaveLength(1);
    const many = Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) => folder(index + 1, `f${index}`));
    const check = checkTree(tree(MAX_TREE_NODES + 1, many));
    expect(check.structural).toEqual([]);
    expect(check.overLimit).toHaveLength(1);
  });
});
