import { clauseImpacts, latestReviews, reviewHistory } from './clauses.mjs';
import { evidenceSummary } from './import.mjs';

export function listChanges(conn) {
  const rows = conn.query(`MATCH (ch:Change)-[:CHANGES]->(t:Clause)
    OPTIONAL MATCH (ch)-[:PROPOSES]->(r:Clause)
    RETURN ch.id AS id, ch.label AS label, t.id AS target, t.text AS targetText,
      t.document AS document, t.version AS version, r.id AS replacement
    ORDER BY id`).rows;
  // Impact count is the queue length, computed from the same confirmed-only
  // traversal the change screen uses, so the index never promises more.
  return rows.map(row => ({ ...row, impacts: clauseImpacts(conn, row.id).length }));
}
export function getChange(conn, id) {
  return conn.query(`MATCH (ch:Change {id:$id})-[:CHANGES]->(t:Clause)
    OPTIONAL MATCH (ch)-[:PROPOSES]->(r:Clause)
    RETURN ch.id AS id, ch.label AS label, t.id AS target, t.text AS targetText,
      t.document AS document, t.version AS version, r.id AS replacement, r.text AS replacementText`, { id }).rows[0] ?? null;
}

/**
 * One reviewable unit: a candidate clause, the confirmed dependency chain that
 * reaches the changed clause, and the current decision. The chain is the evidence.
 */
export function reviewQueue(conn, changeId) {
  const decisions = new Map(latestReviews(conn, changeId).map(r => [r.clauseId, r]));
  return clauseImpacts(conn, changeId).map(row => {
    const clauses = row.path.map(clauseId =>
      conn.query('MATCH (c:Clause {id:$id}) RETURN c.document AS document, c.text AS text', { id: clauseId }).rows[0]);
    const hops = row.path.map((clauseId, i) => ({
      clauseId,
      document: clauses[i].document,
      text: clauses[i].text,
      quote: row.evidence[i]?.quote ?? null
    }));
    const decision = decisions.get(row.id) ?? null;
    return {
      ...row,
      clauses,
      hops,
      decision,
      history: reviewHistory(conn, changeId, row.id),
      state: decision?.status ?? 'pending'
    };
  });
}

export function queueCounts(queue) {
  return {
    total: queue.length,
    confirmed: queue.filter(i => i.state === 'confirmed').length,
    dismissed: queue.filter(i => i.state === 'dismissed').length,
    pending: queue.filter(i => i.state === 'pending').length
  };
}

/** Every clause in the store, grouped for pickers. */
export function listClauses(conn) {
  return conn.query(`MATCH (c:Clause)
    RETURN c.id AS id, c.document AS document, c.version AS version,
      c.text AS text, c.ordinal AS ordinal
    ORDER BY document, version, ordinal, id`).rows;
}

/** Documents in the store, with how many clauses each contributes. */
export function listDocuments(conn) {
  return conn.query(`MATCH (c:Clause)
    RETURN c.document AS document, c.version AS version, count(c) AS clauses
    ORDER BY document, version`).rows;
}

export { evidenceSummary };
