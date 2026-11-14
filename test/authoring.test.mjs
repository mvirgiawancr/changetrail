import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { openStore } from '../src/graph.mjs';
import {
  importDocuments, suggestLinks, confirmLink, addChange, evidenceSummary,
  openSuggestions, dismissSuggestion, dismissedPairs, pairKey
} from '../src/import.mjs';
import { clauseImpacts } from '../src/clauses.mjs';
import { listClauses, listDocuments } from '../src/workbench.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/raw-docs.json', import.meta.url), 'utf8'));

function fresh() {
  const conn = openStore(':memory:');
  importDocuments(conn, pack.documents);
  return conn;
}

test('a pair is keyed the same whichever way round it arrives', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
});

test('two versions of one document are never suggested as a dependency', () => {
  const conn = fresh();
  const suggestions = suggestLinks(conn);
  const byId = new Map(listClauses(conn).map(c => [c.id, c]));
  for (const s of suggestions) {
    assert.notEqual(byId.get(s.a).document, byId.get(s.b).document, `${s.a} and ${s.b} are one document`);
  }
  // The policy has a version 1 and a version 2, both imported.
  assert.ok(byId.get('notification-policy-v1-p1'));
  assert.ok(byId.get('notification-policy-v2-p1'));
});

test('dismissing a pair removes it from open suggestions and never creates an edge', () => {
  const conn = fresh();
  const before = openSuggestions(conn);
  const trap = before.find(s => [s.a, s.b].includes('equipment-returns-v1-p1'));
  assert.ok(trap, 'the equipment paragraph should be suggested');

  dismissSuggestion(conn, {
    a: trap.a, b: trap.b, reviewer: 'Test reviewer',
    reason: 'Equipment returns are a separate process from incident notification'
  });

  const after = openSuggestions(conn);
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some(s => pairKey(s.a, s.b) === pairKey(trap.a, trap.b)));
  assert.equal(conn.query('MATCH ()-[r:DEPENDS_ON]->() RETURN count(r) AS n').single().n, 0);
  assert.equal(dismissedPairs(conn).size, 1);
  assert.throws(() => dismissSuggestion(conn, {
    a: trap.b, b: trap.a, reviewer: 'Test reviewer', reason: 'Same pair, other order'
  }), /already been decided/);
});

test('a dismissal needs a reviewer and a reason', () => {
  const conn = fresh();
  assert.throws(() => dismissSuggestion(conn, { a: 'x', b: 'y', reviewer: ' ', reason: 'why' }), /reviewer/);
  assert.throws(() => dismissSuggestion(conn, { a: 'x', b: 'y', reviewer: 'Test', reason: ' ' }), /reason/);
});

test('confirming a suggestion closes it and makes the impact reachable', () => {
  const conn = fresh();
  const open = openSuggestions(conn);
  const pair = open.find(s => s.a === 'onboarding-checklist-v1-p2' && s.b === 'response-sop-v1-p2');
  assert.ok(pair, 'the logging step should be suggested');

  confirmLink(conn, { from: pair.a, to: pair.b, quote: pair.quoteA, reviewer: 'Test reviewer' });
  assert.ok(!openSuggestions(conn).some(s => pairKey(s.a, s.b) === pairKey(pair.a, pair.b)));
  assert.equal(evidenceSummary(conn).confirmed, 1);

  addChange(conn, { id: 'logging', label: 'Logging step changed', target: 'response-sop-v1-p2' });
  const impacts = clauseImpacts(conn, 'logging');
  assert.deepEqual(impacts.map(r => r.id), ['onboarding-checklist-v1-p2']);
});

test('a whole document can be imported through the same path the browser uses', () => {
  const conn = fresh();
  const clauses = importDocuments(conn, [{
    documentId: 'access-policy', version: '1',
    text: 'Access reviews happen every quarter.\n\nContractors lose access within one business day.'
  }]);
  assert.equal(clauses.length, 2);
  assert.deepEqual(clauses.map(c => c.id), ['access-policy-v1-p1', 'access-policy-v1-p2']);
  const docs = listDocuments(conn);
  assert.ok(docs.some(d => d.document === 'access-policy' && d.clauses === 2));
});

test('authoring routes import, decide a link and register a change', async () => {
  mkdirSync('.work', { recursive: true });
  const dir = mkdtempSync(resolve('.work/author-'));
  const port = 4700 + Math.floor(Math.random() * 200);
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(port), STORE: join(dir, 'author.rl') },
    cwd: process.cwd(),
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }

    for (const page of ['/import', '/links', '/changes/new']) {
      assert.equal((await fetch(base + page)).status, 200, page);
    }

    const imported = await post('/import', {
      documentId: 'access-policy', version: '1',
      text: 'Access reviews happen every quarter.\n\nContractors lose access within one business day.'
    });
    assert.equal(imported.status, 303);

    const duplicate = await post('/import', {
      documentId: 'access-policy', version: '1', text: 'Second attempt.'
    });
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /Clause already imported/);

    const linksHtml = await (await fetch(base + '/links')).text();
    assert.match(linksHtml, /Confirm what depends on what/);

    const noDirection = await post('/link', {
      a: 'responder-training-v1-p1', b: 'response-sop-v1-p1', action: 'confirm', reviewer: 'Test'
    });
    assert.equal(noDirection.status, 400);

    const confirmed = await post('/link', {
      a: 'onboarding-checklist-v1-p2', b: 'response-sop-v1-p2', action: 'confirm',
      direction: 'ab', reviewer: 'Test'
    });
    assert.equal(confirmed.status, 303);

    const dismissed = await post('/link', {
      a: 'equipment-returns-v1-p1', b: 'notification-policy-v1-p1', action: 'dismiss',
      reviewer: 'Test', reason: 'A separate process, not a dependency'
    });
    assert.equal(dismissed.status, 303);

    const created = await post('/changes', {
      id: 'logging-change', label: 'Logging step requires the recipient',
      target: 'response-sop-v1-p2', replacement: ''
    });
    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/change/logging-change');

    const changePage = await (await fetch(base + '/change/logging-change')).text();
    assert.match(changePage, /Impact trace/);
    assert.match(changePage, /onboarding-checklist/);
    assert.match(changePage, /<svg/);

    const dupChange = await post('/changes', {
      id: 'logging-change', label: 'Again', target: 'response-sop-v1-p2'
    });
    assert.equal(dupChange.status, 400);
  } finally {
    child.kill();
  }
});
