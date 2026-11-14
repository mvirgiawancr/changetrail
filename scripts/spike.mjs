import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore, seed, impacts, textBaseline } from '../src/graph.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/incident-pack.json', import.meta.url), 'utf8'));
const mode = process.argv[2] ?? 'read';
const path = resolve(process.argv[3] ?? 'data/demo.rl');
if (mode === 'seed') {
  if (existsSync(path)) throw new Error(`Store already exists: ${path}. Refusing to overwrite.`);
  mkdirSync(resolve(path, '..'), { recursive: true });
  seed(openStore(path), pack);
  console.log(JSON.stringify({ persisted: path, documents: pack.documents.length }));
} else if (mode === 'read') {
  const conn = openStore(path, true);
  console.log(JSON.stringify({ notice: pack.notice, scenarios: pack.scenarios.map(s => ({
    ...s, impacts: impacts(conn, s.root), textBaseline: textBaseline(pack, s)
  })) }, null, 2));
} else {
  throw new Error('Usage: node scripts/spike.mjs seed|read [store-path]');
}
