import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from '../src/graph.mjs';
import { seedClauses, clauseImpacts, review, reviewHistory } from '../src/clauses.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/clause-pack.json', import.meta.url), 'utf8'));
function setup() { const c = openStore(':memory:'); seedClauses(c, pack); return c; }

test('clause traversal isolates same-document unrelated steps across four changes', () => {
  const c = setup();
  for (const change of pack.changes) {
    const results = clauseImpacts(c, change.id);
    assert.deepEqual([...new Set(results.map(r => r.id))].sort(), [...change.expected].sort());
    for (const row of results) row.evidence.forEach((e, i) => {
      assert.ok(pack.clauses.find(clause => clause.id === row.path[i]).text.includes(e.quote));
    });
  }
  assert.ok(!clauseImpacts(c, 'deadline-24h').some(r => r.document === 'logging-checklist'));
});

test('proposed version does not silently replace dependency targets', () => {
  const c = setup();
  assert.equal(c.query("MATCH (:Clause {id:'policy-deadline-v2'})<-[r:DEPENDS_ON]-() RETURN count(r) AS n").single().n, 0);
  assert.equal(clauseImpacts(c, 'deadline-24h').length, 3);
});

test('review history is append-only and scoped to the change', () => {
  const c = setup();
  const base = { changeId:'deadline-24h', clauseId:'checklist-notify', reviewer:'Demo reviewer' };
  review(c, { ...base, status:'confirmed', reason:'Indirect deadline reference requires review' });
  review(c, { ...base, status:'dismissed', reason:'Checklist inherits deadline dynamically; no text edit needed' });
  assert.equal(reviewHistory(c, base.changeId, base.clauseId).length, 2);
  assert.equal(reviewHistory(c, 'deadline-second-review', base.clauseId).length, 0);
  assert.throws(() => review(c, { ...base, clauseId:'equipment-return', status:'confirmed', reason:'Wrong candidate' }), /Not an impact/);
  assert.throws(() => review(c, { ...base, status:'done', reason:'Invalid' }), /Invalid review/);
  assert.throws(() => clauseImpacts(c, 'missing'), /Unknown Change/);
});

test('bad evidence rejected before graph writes', () => {
  const c = openStore(':memory:');
  const bad = structuredClone(pack); bad.dependencies[0].quote = 'Fabricated';
  assert.throws(() => seedClauses(c, bad), /Invalid clause evidence/);
  assert.equal(c.query('MATCH (c:Clause) RETURN count(c) AS n').single().n, 0);
});

test('clause store and review decision survive fresh process reads', () => {
  mkdirSync('.work', { recursive:true });
  const path = join(mkdtempSync(resolve('.work/clauses-')), 'review.rl');
  execFileSync(process.execPath, [resolve('scripts/clauses.mjs'), 'seed', path]);
  const write = `import {openStore} from './src/graph.mjs';
    import {review} from './src/clauses.mjs';
    review(openStore(${JSON.stringify(path)}), {changeId:'deadline-24h', clauseId:'sop-notify',
      status:'confirmed', reason:'Verify inherited deadline', reviewer:'Test reviewer'});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', write]);
  const read = `import {openStore} from './src/graph.mjs';
    import {reviewHistory} from './src/clauses.mjs';
    console.log(JSON.stringify(reviewHistory(openStore(${JSON.stringify(path)}, true), 'deadline-24h', 'sop-notify')));`;
  const history = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', read], {encoding:'utf8'}));
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'confirmed');
});
