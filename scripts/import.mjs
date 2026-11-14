import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openStore } from '../src/graph.mjs';
import { clauseImpacts, latestReviews } from '../src/clauses.mjs';
import { importDocuments, suggestLinks, confirmLink, addChange, evidenceSummary } from '../src/import.mjs';

const pack = JSON.parse(readFileSync(new URL('../fixtures/raw-docs.json', import.meta.url), 'utf8'));
const mode = process.argv[2] ?? 'read';
const path = resolve(process.argv[3] ?? 'data/imported.rl');
const REVIEWER = 'Demo reviewer (fixture)';

// Human decisions, written down so the demo is reproducible. Nothing here is inferred.
const CONFIRMED = [
  { from: 'response-sop-v1-p1', to: 'notification-policy-v1-p1',
    quote: 'follow the notification policy deadline and notify the response lead' },
  { from: 'onboarding-checklist-v1-p1', to: 'response-sop-v1-p1',
    quote: 'Practice the incident notification step described in the standard operating procedure.' },
  { from: 'responder-training-v1-p1', to: 'notification-policy-v1-p1',
    quote: 'notify the response lead within 72 hours' }
];

if (mode === 'seed') {
  if (existsSync(path)) throw new Error(`Store already exists: ${path}. Refusing to overwrite.`);
  mkdirSync(dirname(path), { recursive: true });
  const conn = openStore(path);
  const clauses = importDocuments(conn, pack.documents);
  const suggestions = suggestLinks(conn);
  for (const link of CONFIRMED) confirmLink(conn, { ...link, reviewer: REVIEWER });
  addChange(conn, { id: 'deadline-24h', label: 'Notification deadline 72 hours to 24 hours',
    target: 'notification-policy-v1-p1', replacement: 'notification-policy-v2-p1' });
  console.log(JSON.stringify({
    persisted: path,
    importedClauses: clauses.length,
    suggestions: suggestions.map(s => ({ ...s })),
    confirmedLinks: CONFIRMED.length,
    summary: evidenceSummary(conn)
  }, null, 2));
} else {
  const conn = openStore(path, true);
  console.log(JSON.stringify({
    notice: pack.notice,
    summary: evidenceSummary(conn),
    impacts: clauseImpacts(conn, 'deadline-24h'),
    reviews: latestReviews(conn, 'deadline-24h')
  }, null, 2));
}
