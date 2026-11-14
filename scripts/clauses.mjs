import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openStore } from '../src/graph.mjs';
import { seedClauses, clauseImpacts } from '../src/clauses.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/clause-pack.json', import.meta.url), 'utf8'));
const path = resolve(process.argv[3] ?? 'data/clauses.rl');
if (process.argv[2] === 'seed') {
  if (existsSync(path)) throw new Error('Refusing to overwrite an existing store');
  mkdirSync(dirname(path), { recursive: true });
  seedClauses(openStore(path), pack);
  console.log(`Persisted clause graph: ${path}`);
} else {
  const c = openStore(path, true);
  console.log(JSON.stringify({ notice: pack.notice, scenarios: pack.changes.map(change => ({
    ...change, candidates: clauseImpacts(c, change.id)
  })) }, null, 2));
}
