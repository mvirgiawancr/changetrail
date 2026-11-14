import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, seed, impacts, textBaseline } from '../src/graph.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/incident-pack.json', import.meta.url), 'utf8'));

test('curated graph matches independently declared impacts for three changes', () => {
  const conn = openStore(':memory:');
  seed(conn, pack);
  for (const s of pack.scenarios) {
    const rows = impacts(conn, s.root);
    assert.deepEqual(rows.map(r => r.id).sort(), [...s.expected].sort(), s.id);
    for (const row of rows) {
      assert.equal(row.path.at(-1), s.root);
      assert.equal(row.evidence.length, row.path.length - 1);
      row.evidence.forEach((e, i) => {
        assert.equal(e.status, 'manually-confirmed');
        assert.ok(pack.documents.find(d => d.id === row.path[i]).text.includes(e.quote));
      });
    }
  }
});

test('text baseline misses the indirect checklist and flags unrelated equipment', () => {
  const baseline = textBaseline(pack, pack.scenarios[0]);
  assert.ok(!baseline.includes('onboarding-checklist'));
  assert.ok(baseline.includes('equipment-returns'));
});

test('invalid source evidence is rejected before writing', () => {
  const bad = structuredClone(pack);
  bad.relationships[0].quote = 'Fabricated quote';
  const conn = openStore(':memory:');
  assert.throws(() => seed(conn, bad), /Invalid evidence/);
  assert.equal(conn.query('MATCH (d:Document) RETURN count(d) AS count').single().count, 0);
});

test('single-file store survives process exit and is readable in a fresh process', () => {
  mkdirSync('.work', { recursive: true });
  const path = join(mkdtempSync(resolve('.work/persistence-')), 'test.rl');
  const script = resolve('scripts/spike.mjs');
  execFileSync(process.execPath, [script, 'seed', path], { encoding: 'utf8' });
  const result = JSON.parse(execFileSync(process.execPath, [script, 'read', path], { encoding: 'utf8' }));
  for (const s of result.scenarios) assert.deepEqual(s.impacts.map(r => r.id).sort(), [...s.expected].sort());
  assert.throws(() => execFileSync(process.execPath, [script, 'seed', path], { stdio: 'pipe' }));
});
