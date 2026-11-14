function requireOne(conn, label, id) {
  // Labels are internal constants, never caller-provided query syntax.
  const query = label === 'Change'
    ? 'MATCH (n:Change {id: $id}) RETURN n.id AS id'
    : 'MATCH (n:Clause {id: $id}) RETURN n.id AS id';
  if (conn.query(query, { id }).rows.length !== 1) throw new Error(`Unknown ${label}: ${id}`);
}

export function seedClauses(conn, pack) {
  const ids = new Set(pack.clauses.map(c => c.id));
  if (ids.size !== pack.clauses.length) throw new Error('Duplicate clause id');
  if (new Set(pack.changes.map(c => c.id)).size !== pack.changes.length) throw new Error('Duplicate change id');
  for (const e of pack.dependencies) {
    if (!ids.has(e.to) || !pack.clauses.find(c => c.id === e.from)?.text.includes(e.quote)) {
      throw new Error('Invalid clause evidence');
    }
  }
  for (const c of pack.changes) {
    if (!ids.has(c.target) || (c.replacement && !ids.has(c.replacement))) throw new Error('Invalid change target');
  }
  if (conn.query('MATCH (c:Clause) RETURN count(c) AS n').single().n) throw new Error('Clause store must be empty');
  conn.begin();
  try {
    for (const c of pack.clauses) conn.query('CREATE (:Clause {id:$id, document:$document, version:$version, text:$text})', c);
    for (const e of pack.dependencies) conn.query(`MATCH (a:Clause {id:$from}), (b:Clause {id:$to})
      CREATE (a)-[:DEPENDS_ON {quote:$quote, provenance:'manually-confirmed'}]->(b)`, e);
    for (const c of pack.changes) {
      conn.query('MATCH (t:Clause {id:$target}) CREATE (:Change {id:$id})-[:CHANGES]->(t)', c);
      if (c.replacement) conn.query(`MATCH (c:Change {id:$id}), (n:Clause {id:$replacement})
        CREATE (c)-[:PROPOSES]->(n)`, c);
    }
    conn.commit();
  } catch (error) {
    conn.rollback();
    throw error;
  }
}

export function clauseImpacts(conn, changeId) {
  requireOne(conn, 'Change', changeId);
  // Only human-confirmed evidence may drive impact results. Suggested links are
  // candidates and must never silently reach a reviewer's queue.
  return conn.query(`MATCH (change:Change {id:$changeId})-[:CHANGES]->(target:Clause)
    MATCH p=(candidate:Clause)-[deps:DEPENDS_ON*1..8]->(target)
    WHERE candidate.id <> target.id
      AND all(r IN deps WHERE r.provenance = 'manually-confirmed')
    RETURN candidate.id AS id, candidate.document AS document,
      candidate.text AS text, [n IN nodes(p) | n.id] AS path,
      [r IN relationships(p) | {quote:r.quote, provenance:r.provenance}] AS evidence
    ORDER BY id`, { changeId }).rows;
}

export function review(conn, { changeId, clauseId, status, reason, reviewer }) {
  if (!['confirmed', 'dismissed', 'pending'].includes(status)) throw new Error('Invalid review status');
  if (typeof reason !== 'string' || !reason.trim() || typeof reviewer !== 'string' || !reviewer.trim()) {
    throw new Error('Review requires reason and reviewer');
  }
  if (!clauseImpacts(conn, changeId).some(r => r.id === clauseId)) throw new Error('Not an impact candidate');
  const seq = conn.query(`MATCH (:Change {id:$changeId})-[r:REVIEWED]->(:Clause {id:$clauseId})
    RETURN count(r) AS n`, { changeId, clauseId }).single().n + 1;
  conn.query(`MATCH (change:Change {id:$changeId}), (clause:Clause {id:$clauseId})
    CREATE (change)-[:REVIEWED {status:$status, reason:$reason, reviewer:$reviewer, at:$at, seq:$seq}]->(clause)`,
  { changeId, clauseId, status, reason, reviewer, at: new Date().toISOString(), seq });
}

export function reviewHistory(conn, changeId, clauseId) {
  requireOne(conn, 'Change', changeId);
  return conn.query(`MATCH (:Change {id:$changeId})-[r:REVIEWED]->(:Clause {id:$clauseId})
    RETURN r.status AS status, r.reason AS reason, r.reviewer AS reviewer, r.at AS at,
      r.seq AS seq
    ORDER BY seq`, { changeId, clauseId }).rows;
}

/** Latest decision per clause, ordered by an explicit sequence rather than timestamps. */
export function latestReviews(conn, changeId) {
  requireOne(conn, 'Change', changeId);
  return conn.query(`MATCH (:Change {id:$changeId})-[r:REVIEWED]->(c:Clause)
    WITH c, r ORDER BY r.seq DESC
    WITH c, collect(r)[0] AS latest
    RETURN c.id AS clauseId, latest.status AS status, latest.reason AS reason,
      latest.reviewer AS reviewer, latest.at AS at, latest.seq AS seq
    ORDER BY clauseId`, { changeId }).rows;
}
