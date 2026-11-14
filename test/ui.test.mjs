import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { openStore } from '../src/graph.mjs';
import { diffWords, marked, esc } from '../src/ui.mjs';
import { getChange, listChanges, reviewQueue, queueCounts } from '../src/workbench.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/raw-docs.json', import.meta.url), 'utf8'));

test('word diff marks only the changed tokens', () => {
  const { before, after } = diffWords('notify within 72 hours', 'notify within 24 hours');
  assert.match(before, /<del>72<\/del>/);
  assert.match(after, /<ins>24<\/ins>/);
  assert.doesNotMatch(before, /<del>notify/);
  assert.doesNotMatch(after, /<ins>notify/);
});

test('diff output is escaped, never injected', () => {
  const { after } = diffWords('safe', '<script>alert(1)</script>');
  assert.doesNotMatch(after, /<script>/);
  assert.match(after, /&lt;script&gt;/);
  assert.equal(esc('"x"'), '&quot;x&quot;');
});

test('quote marking escapes the surrounding text and marks the quote once', () => {
  const html = marked('A <b>bold</b> quote here', 'bold');
  assert.match(html, /&lt;b&gt;/);
  assert.equal(html.match(/<mark>/g).length, 1);
  assert.equal(marked('no match', 'absent'), 'no match');
});

test('the served store renders a queue with real evidence chains', async () => {
  mkdirSync('.work', { recursive: true });
  const dir = mkdtempSync(resolve('.work/ui-'));
  const store = join(dir, 'ui.rl');
  copyFileSync(resolve('data/imported.rl'), store);
  const conn = openStore(store, true);

  const changes = listChanges(conn);
  assert.equal(changes.length, 1);
  const change = getChange(conn, changes[0].id);
  assert.match(change.replacementText, /24 hours/);

  const queue = reviewQueue(conn, change.id);
  assert.equal(queue.length, 3);
  for (const item of queue) {
    assert.equal(item.hops.length, item.path.length);
    assert.equal(item.hops.at(-1).clauseId, change.target);
    assert.ok(item.hops.slice(0, -1).every(hop => hop.quote && hop.text.includes(hop.quote)));
    assert.ok(['pending', 'confirmed', 'dismissed'].includes(item.state));
  }
  const counts = queueCounts(queue);
  assert.equal(counts.total, counts.pending + counts.confirmed + counts.dismissed);
  assert.ok(!queue.some(item => item.document === 'equipment-returns'), 'unconfirmed suggestion must stay out');
});

test('server serves index, change page, CSS and a validation error', async () => {
  mkdirSync('.work', { recursive: true });
  const dir = mkdtempSync(resolve('.work/serve-'));
  const port = 4300 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, PORT: String(port), STORE: join(dir, 'served.rl') },
    cwd: process.cwd(),
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  const waitFor = async () => {
    for (let i = 0; i < 60; i++) {
      try { await fetch(base); return; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
  };
  try {
    await waitFor();
    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Open changes/);

    const css = await fetch(`${base}/app.css`);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');

    const page = await fetch(`${base}/change/deadline-24h`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<mark>/);

    const missing = await fetch(`${base}/change/nope`);
    assert.equal(missing.status, 404);

    const bad = await fetch(`${base}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'changeId=deadline-24h&clauseId=response-sop-v1-p1&status=confirmed&reason=&reviewer='
    });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /Decision was not recorded/);

    const good = await fetch(`${base}/review`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'changeId=deadline-24h&clauseId=response-sop-v1-p1&status=confirmed&reason=Checked+the+inherited+deadline&reviewer=Test'
    });
    assert.equal(good.status, 303);
    const after = await (await fetch(`${base}/change/deadline-24h?c=response-sop-v1-p1`)).text();
    // Assert the recorded decision, not a stylesheet class: the theme may change.
    assert.match(after, /Checked the inherited deadline/);
    assert.match(after, /Confirmed/);
  } finally {
    child.kill();
  }
});
