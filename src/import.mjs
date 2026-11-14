import { clauseImpacts } from './clauses.mjs';

const STOPWORDS = new Set(('a an the and or of to in on for with by from as at is are be been ' +
  'was were this that these those it its if then than not no must may can should shall will ' +
  'would do does did after before under over into per any all each other such only own same ' +
  'so too very now also more most which who whom whose what when where while there their them').split(' '));

const TOKEN_LIMIT = 300;

function tokenize(text) {
  return [...String(text).matchAll(/[A-Za-z0-9]+/g)]
    .slice(0, TOKEN_LIMIT)
    .map(m => ({ value: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
}

/**
 * Deterministic split of a plain-text document into clause-sized paragraphs.
 * No model, no summarisation: the same input always yields the same clause ids.
 */
export function splitClauses({ documentId, version, text }) {
  if (!documentId || !version) throw new Error('documentId and version are required');
  const paragraphs = String(text).split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error(`Document ${documentId} has no text`);
  return paragraphs.map((body, i) => ({
    id: `${documentId}-v${version}-p${i + 1}`,
    document: documentId,
    version: String(version),
    ordinal: i + 1,
    text: body
  }));
}

/** Import documents as clauses. Creates no dependency edges at all. */
export function importDocuments(conn, documents) {
  const clauses = documents.flatMap(splitClauses);
  const ids = new Set(clauses.map(c => c.id));
  if (ids.size !== clauses.length) throw new Error('Duplicate clause id in import');
  for (const clause of clauses) {
    if (conn.query('MATCH (c:Clause {id:$id}) RETURN c.id AS id', { id: clause.id }).rows.length) {
      throw new Error(`Clause already imported: ${clause.id}`);
    }
  }
  conn.begin();
  try {
    for (const c of clauses) {
      conn.query(`CREATE (:Clause {id:$id, document:$document, version:$version,
        ordinal:$ordinal, text:$text, provenance:'imported'})`, c);
    }
    conn.commit();
  } catch (error) {
    conn.rollback();
    throw error;
  }
  return clauses;
}

/**
 * Lexical candidate links. These are hints for a human, never graph edges:
 * shared wording does not establish which clause depends on which, so direction
 * is deliberately left undetermined.
 */
export function suggestLinks(conn, { minRun = 3 } = {}) {
  const clauses = conn.query(`MATCH (c:Clause) RETURN c.id AS id, c.document AS document, c.text AS text ORDER BY id`).rows;
  const prepared = clauses.map(c => ({ id: c.id, document: c.document, text: c.text, tokens: tokenize(c.text) }));
  const out = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      // Two versions of one document are a supersession, not a dependency:
      // suggesting them as linked would put the old text in a review queue.
      if (a.document === b.document) continue;
      let best = { run: 0, ai: 0, bi: 0 };
      for (let x = 0; x < a.tokens.length; x++) {
        for (let y = 0; y < b.tokens.length; y++) {
          let run = 0;
          while (x + run < a.tokens.length && y + run < b.tokens.length
            && a.tokens[x + run].value === b.tokens[y + run].value) run++;
          if (run > best.run) best = { run, ai: x, bi: y };
        }
      }
      if (best.run < minRun) continue;
      const window = a.tokens.slice(best.ai, best.ai + best.run);
      if (window.filter(t => !STOPWORDS.has(t.value)).length < 2) continue;
      const quoteA = a.text.slice(window[0].start, window[window.length - 1].end);
      const windowB = b.tokens.slice(best.bi, best.bi + best.run);
      const quoteB = b.text.slice(windowB[0].start, windowB[windowB.length - 1].end);
      if (!a.text.includes(quoteA) || !b.text.includes(quoteB)) continue;
      out.push({ a: a.id, b: b.id, run: best.run, quoteA, quoteB, direction: 'undetermined' });
    }
  }
  return out.sort((p, q) => q.run - p.run || p.a.localeCompare(q.a));
}

/** Record a human-confirmed dependency. The quote must exist in the source clause. */
export function confirmLink(conn, { from, to, quote, reviewer }) {
  if (from === to) throw new Error('A clause cannot depend on itself');
  if (typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('confirmLink requires a reviewer');
  const source = conn.query('MATCH (c:Clause {id:$id}) RETURN c.text AS text', { id: from }).rows[0];
  const target = conn.query('MATCH (c:Clause {id:$id}) RETURN c.id AS id', { id: to }).rows[0];
  if (!source || !target) throw new Error('Both clauses must exist');
  if (typeof quote !== 'string' || !quote.trim() || !source.text.includes(quote)) {
    throw new Error('Quote is not present in the source clause');
  }
  const existing = conn.query(`MATCH (:Clause {id:$from})-[r:DEPENDS_ON]->(:Clause {id:$to})
    RETURN count(r) AS n`, { from, to }).single().n;
  if (existing) throw new Error('Dependency already recorded');
  conn.query(`MATCH (a:Clause {id:$from}), (b:Clause {id:$to})
    CREATE (a)-[:DEPENDS_ON {quote:$quote, provenance:'manually-confirmed',
      reviewer:$reviewer, at:$at}]->(b)`,
  { from, to, quote, reviewer, at: new Date().toISOString() });
}

/** Register a change against an existing clause. Nothing is inferred from text. */
export function addChange(conn, { id, target, replacement = null, label }) {
  if (!id || !label) throw new Error('addChange requires id and label');
  if (conn.query('MATCH (c:Change {id:$id}) RETURN c.id AS id', { id }).rows.length) {
    throw new Error(`Change already exists: ${id}`);
  }
  const targetClause = conn.query('MATCH (c:Clause {id:$id}) RETURN c.id AS id, c.version AS version', { id: target }).rows[0];
  if (!targetClause) throw new Error(`Unknown target clause: ${target}`);
  if (replacement) {
    const next = conn.query('MATCH (c:Clause {id:$id}) RETURN c.id AS id, c.version AS version', { id: replacement }).rows[0];
    if (!next) throw new Error(`Unknown replacement clause: ${replacement}`);
    if (next.version === targetClause.version) throw new Error('Replacement must be a different version');
  }
  conn.query(`MATCH (t:Clause {id:$target})
    CREATE (ch:Change {id:$id, label:$label})-[:CHANGES]->(t)`, { id, label, target });
  if (replacement) {
    conn.query(`MATCH (ch:Change {id:$id}), (n:Clause {id:$replacement})
      CREATE (ch)-[:PROPOSES]->(n)`, { id, replacement });
  }
}

/** Counts used to report how much of the graph is human-confirmed. */
export function evidenceSummary(conn) {
  return conn.query(`MATCH (c:Clause) WITH count(c) AS clauses
    MATCH ()-[r:DEPENDS_ON]->()
    RETURN clauses, count(r) AS dependencies,
      sum(CASE WHEN r.provenance = 'manually-confirmed' THEN 1 ELSE 0 END) AS confirmed,
      sum(CASE WHEN r.provenance = 'suggested' THEN 1 ELSE 0 END) AS suggested`).single();
}

/** A stable key for an unordered pair, so a dismissal covers both directions. */
export function pairKey(a, b) {
  return [a, b].sort().join('|');
}

/**
 * Record that a reviewer rejected a lexical suggestion. The suggestion is not an
 * edge, so a dismissal is only a note that this pair was already considered.
 */
export function dismissSuggestion(conn, { a, b, reviewer, reason }) {
  if (typeof reviewer !== 'string' || !reviewer.trim()) throw new Error('A dismissal needs a reviewer');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('A dismissal needs a reason');
  const key = pairKey(a, b);
  if (conn.query('MATCH (d:SuggestionDecision {key:$key}) RETURN d.key AS key', { key }).rows.length) {
    throw new Error('This pair has already been decided');
  }
  conn.query(`CREATE (:SuggestionDecision {key:$key, a:$a, b:$b, status:'dismissed',
    reviewer:$reviewer, reason:$reason, at:$at})`,
  { key, a, b, reviewer, reason, at: new Date().toISOString() });
}

/** Every pair a reviewer has already dismissed, by pair key. */
export function dismissedPairs(conn) {
  return new Map(conn.query(`MATCH (d:SuggestionDecision)
    RETURN d.key AS key, d.reviewer AS reviewer, d.reason AS reason, d.at AS at`).rows
    .map(row => [row.key, row]));
}

/** Suggestions a reviewer has not yet dismissed or confirmed. */
export function openSuggestions(conn, { minRun = 3 } = {}) {
  const decided = dismissedPairs(conn);
  const confirmed = new Set(conn.query(`MATCH (a:Clause)-[:DEPENDS_ON]->(b:Clause)
    RETURN a.id AS a, b.id AS b`).rows.map(r => pairKey(r.a, r.b)));
  return suggestLinks(conn, { minRun })
    .filter(s => !decided.has(pairKey(s.a, s.b)) && !confirmed.has(pairKey(s.a, s.b)));
}

export { clauseImpacts };
