import { Database } from '@relate/relate';

export function openStore(path, readOnly = false) {
  return Database.open(path, { readOnly }).connect();
}

export function seed(conn, pack) {
  if (conn.query('MATCH (d:Document) RETURN count(d) AS count').single().count !== 0) {
    throw new Error('Seed requires an empty document store; refusing to overwrite existing data.');
  }
  // Validate evidence before any write. Edges are explicitly curated, not inferred.
  for (const edge of pack.relationships) {
    const source = pack.documents.find(d => d.id === edge.from);
    if (!source?.text.includes(edge.quote) || !pack.documents.some(d => d.id === edge.to)) {
      throw new Error(`Invalid evidence or target: ${edge.from} -> ${edge.to}`);
    }
  }
  for (const doc of pack.documents) {
    conn.query('CREATE (:Document {id: $id, title: $title, text: $text})', doc);
  }
  for (const edge of pack.relationships) {
    conn.query(`MATCH (a:Document {id: $from}), (b:Document {id: $to})
      CREATE (a)-[:DEPENDS_ON {quote: $quote, status: $status}]->(b)`, edge);
  }
}

export function impacts(conn, root) {
  return conn.query(`MATCH p=(d:Document)-[:DEPENDS_ON*1..8]->(root:Document {id: $root})
    WHERE d.id <> $root
    RETURN d.id AS id, d.title AS title,
      [n IN nodes(p) | n.id] AS path,
      [r IN relationships(p) | {quote: r.quote, status: r.status}] AS evidence
    ORDER BY id`, { root }).rows;
}

export function textBaseline(pack, scenario) {
  return pack.documents.filter(d => d.id !== scenario.root && d.text.includes(scenario.before)).map(d => d.id).sort();
}
