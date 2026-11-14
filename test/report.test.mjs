import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { openStore } from '../src/graph.mjs';
import { importDocuments, confirmLink, addChange } from '../src/import.mjs';
import { review } from '../src/clauses.mjs';
import { buildReport, reportMarkdown } from '../src/report.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/raw-docs.json', import.meta.url), 'utf8'));

function seeded({ decide = false } = {}) {
  const conn = openStore(':memory:');
  importDocuments(conn, pack.documents);
  confirmLink(conn, {
    from: 'onboarding-checklist-v1-p1', to: 'response-sop-v1-p1',
    quote: 'Practice the incident notification step described in the standard operating procedure.',
    reviewer: 'Test reviewer'
  });
  confirmLink(conn, {
    from: 'response-sop-v1-p1', to: 'notification-policy-v1-p1',
    quote: 'follow the notification policy deadline and notify the response lead',
    reviewer: 'Test reviewer'
  });
  addChange(conn, {
    id: 'deadline-24h', label: 'Notification deadline 72 hours to 24 hours',
    target: 'notification-policy-v1-p1', replacement: 'notification-policy-v2-p1'
  });
  if (decide) {
    review(conn, {
      changeId: 'deadline-24h', clauseId: 'response-sop-v1-p1',
      status: 'confirmed', reason: 'Restates the deadline, must be edited',
      reviewer: 'Test reviewer'
    });
  }
  return conn;
}

test('an unknown change has no report', () => {
  assert.equal(buildReport(seeded(), 'not-a-change'), null);
});

test('the report is built from the same queue the screen shows', () => {
  const report = buildReport(seeded(), 'deadline-24h');
  assert.equal(report.counts.total, 2);
  assert.equal(report.counts.pending, 2);
  assert.equal(report.complete, false);
  assert.deepEqual(report.groups.map(g => g.state), ['confirmed', 'pending', 'dismissed']);
  assert.deepEqual(
    report.groups.find(g => g.state === 'pending').items.map(i => i.id).sort(),
    ['onboarding-checklist-v1-p1', 'response-sop-v1-p1']
  );
});

test('the report is complete only when nothing is pending', () => {
  const conn = seeded({ decide: true });
  review(conn, {
    changeId: 'deadline-24h', clauseId: 'onboarding-checklist-v1-p1',
    status: 'dismissed', reason: 'References the SOP, no wording edit needed',
    reviewer: 'Test reviewer'
  });
  const report = buildReport(conn, 'deadline-24h');
  assert.equal(report.counts.pending, 0);
  assert.equal(report.complete, true);
});

test('the markdown carries the evidence quotes and the decisions', () => {
  const conn = seeded({ decide: true });
  const markdown = reportMarkdown(buildReport(conn, 'deadline-24h'));
  assert.match(markdown, /^# Impact review: Notification deadline 72 hours to 24 hours/m);
  assert.match(markdown, /### Needs an edit \(1\)/);
  assert.match(markdown, /### Needs review \(1\)/);
  assert.match(markdown, /follow the notification policy deadline/);
  assert.match(markdown, /Restates the deadline, must be edited/);
  assert.match(markdown, /Proposed: Incident notification policy\. Notify the response lead within 24 hours/);
  assert.match(markdown, /## Method/);
  assert.match(markdown, /Status: 1 of 2 still open/);
});

test('an unconfirmed suggestion never appears in the handoff', () => {
  const markdown = reportMarkdown(buildReport(seeded(), 'deadline-24h'));
  assert.doesNotMatch(markdown, /equipment-returns/);
  assert.doesNotMatch(markdown, /responder-training/);
});

test('a change nothing depends on reports that as a result, not an error', () => {
  const conn = openStore(':memory:');
  importDocuments(conn, pack.documents);
  addChange(conn, { id: 'lonely', label: 'Equipment deadline', target: 'equipment-returns-v1-p1' });
  const report = buildReport(conn, 'lonely');
  assert.equal(report.counts.total, 0);
  assert.equal(report.complete, false);
  assert.equal(report.status, 'nothing to review');
  const markdown = reportMarkdown(report);
  assert.match(markdown, /nothing downstream references it/i);
  assert.match(markdown, /Status: nothing to review/);
});

test('both report routes serve the same content', async () => {
  mkdirSync('.work', { recursive: true });
  const dir = mkdtempSync(resolve('.work/report-'));
  const port = 4900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(port), STORE: join(dir, 'report.rl') },
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

    const page = await fetch(`${base}/change/deadline-24h/report`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Impact review/);
    assert.match(html, /Download as Markdown/);
    assert.match(html, /Needs review/);

    const md = await fetch(`${base}/change/deadline-24h/report.md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type'), /text\/markdown/);
    assert.match(md.headers.get('content-disposition'), /attachment; filename="impact-review-deadline-24h\.md"/);
    const body = await md.text();
    assert.match(body, /^# Impact review:/);

    const missing = await fetch(`${base}/change/nope/report`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill();
  }
});
