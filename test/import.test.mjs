import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/graph.mjs';
import { clauseImpacts, review, latestReviews } from '../src/clauses.mjs';
import { splitClauses, importDocuments, suggestLinks, confirmLink, addChange, evidenceSummary } from '../src/import.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/raw-docs.json', import.meta.url), 'utf8'));

function imported() {
  const conn = openStore(':memory:');
  const clauses = importDocuments(conn, pack.documents);
  return { conn, clauses };
}

test('paragraph split is deterministic and creates no edges', () => {
  const sop = pack.documents.find(d => d.documentId === 'response-sop');
  const a = splitClauses(sop);
  const b = splitClauses(sop);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(a[0].id, 'response-sop-v1-p1');
  const { conn, clauses } = imported();
  assert.equal(clauses.length, 12);
  assert.equal(conn.query('MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS n').single().n, 0);
});

test('suggestions are returned but never persisted as edges', () => {
  const { conn } = imported();
  const suggestions = suggestLinks(conn);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.every(s => s.direction === 'undetermined'));
  assert.equal(conn.query('MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS n').single().n, 0);
  for (const s of suggestions) {
    const texts = conn.query('MATCH (c:Clause) WHERE c.id IN [$a,$b] RETURN c.id AS id, c.text AS text', { a: s.a, b: s.b }).rows;
    const byId = Object.fromEntries(texts.map(t => [t.id, t.text]));
    assert.ok(byId[s.a].includes(s.quoteA));
    assert.ok(byId[s.b].includes(s.quoteB));
  }
});

test('the equipment deadline surfaces as a suggestion a reviewer must reject', () => {
  const { conn } = imported();
  const s = suggestLinks(conn).find(x => x.a === 'equipment-returns-v1-p1' || x.b === 'equipment-returns-v1-p1');
  assert.ok(s, 'expected a lexical collision with the equipment paragraph');
  assert.match(s.quoteA + s.quoteB, /72 hours/);
});

test('fabricated evidence cannot create a confirmed edge', () => {
  const { conn } = imported();
  assert.throws(() => confirmLink(conn, {
    from: 'response-sop-v1-p1', to: 'notification-policy-v1-p1',
    quote: 'the SOP requires 24 hours', reviewer: 'Test'
  }), /not present in the source clause/);
  assert.throws(() => confirmLink(conn, {
    from: 'response-sop-v1-p1', to: 'response-sop-v1-p1',
    quote: 'Incident response', reviewer: 'Test'
  }), /cannot depend on itself/);
  assert.equal(conn.query('MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS n').single().n, 0);
});

test('only confirmed links become impacts; the unconfirmed suggestion stays out', () => {
  const { conn } = imported();
  const suggestions = suggestLinks(conn);
  const equipmentPair = suggestions.find(x => [x.a, x.b].includes('equipment-returns-v1-p1'));
  confirmLink(conn, { from: 'response-sop-v1-p1', to: 'notification-policy-v1-p1',
    quote: 'follow the notification policy deadline and notify the response lead', reviewer: 'Test' });
  confirmLink(conn, { from: 'onboarding-checklist-v1-p1', to: 'response-sop-v1-p1',
    quote: 'Practice the incident notification step described in the standard operating procedure.', reviewer: 'Test' });
  addChange(conn, { id: 'deadline', label: 'Deadline change', target: 'notification-policy-v1-p1' });

  const ids = clauseImpacts(conn, 'deadline').map(r => r.id).sort();
  assert.deepEqual(ids, ['onboarding-checklist-v1-p1', 'response-sop-v1-p1']);
  assert.ok(!ids.includes(equipmentPair.a) && !ids.includes(equipmentPair.b));
  assert.ok(!ids.includes('responder-training-v1-p1'), 'training was never confirmed');

  const summary = evidenceSummary(conn);
  assert.equal(summary.confirmed, 2);
  assert.equal(summary.suggested, 0);
});

test('replacement version must differ and unknown targets are refused', () => {
  const { conn } = imported();
  importDocuments(conn, [{ documentId: 'notification-policy', version: '3',
    text: 'Incident notification policy. Notify the response lead within 12 hours of confirming an incident.' }]);
  assert.throws(() => addChange(conn, { id: 'x', label: 'x', target: 'missing-clause' }), /Unknown target/);
  assert.throws(() => addChange(conn, { id: 'y', label: 'y',
    target: 'notification-policy-v1-p1', replacement: 'notification-policy-v1-p1' }), /different version/);
  assert.throws(() => importDocuments(conn, [pack.documents[0]]), /already imported/);
  addChange(conn, { id: 'ok', label: 'ok', target: 'notification-policy-v1-p1', replacement: 'notification-policy-v3-p1' });
});

test('latest review wins by sequence even when timestamps collide', () => {
  const { conn } = imported();
  confirmLink(conn, { from: 'response-sop-v1-p1', to: 'notification-policy-v1-p1',
    quote: 'follow the notification policy deadline and notify the response lead', reviewer: 'Test' });
  addChange(conn, { id: 'deadline', label: 'Deadline change', target: 'notification-policy-v1-p1' });
  const base = { changeId: 'deadline', clauseId: 'response-sop-v1-p1', reviewer: 'Test' };
  review(conn, { ...base, status: 'pending', reason: 'Needs owner' });
  review(conn, { ...base, status: 'confirmed', reason: 'Deadline inherited, must edit' });
  review(conn, { ...base, status: 'dismissed', reason: 'Reference resolves dynamically' });
  const latest = latestReviews(conn, 'deadline');
  assert.equal(latest.length, 1);
  assert.equal(latest[0].status, 'dismissed');
  assert.equal(latest[0].seq, 3);
});
