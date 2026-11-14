import { getChange, reviewQueue, queueCounts } from './workbench.mjs';

const STATE_LABEL = { confirmed: 'Needs an edit', dismissed: 'No edit needed', pending: 'Needs review' };

/**
 * One report, built from the same review queue the screen shows, so a handoff
 * can never disagree with what the reviewer saw.
 */
export function buildReport(conn, changeId) {
  const change = getChange(conn, changeId);
  if (!change) return null;
  const queue = reviewQueue(conn, changeId);
  const counts = queueCounts(queue);
  const groups = ['confirmed', 'pending', 'dismissed'].map(state => ({
    state,
    label: STATE_LABEL[state],
    items: queue.filter(item => item.state === state)
  }));
  return {
    change,
    queue,
    counts,
    groups,
    generatedAt: new Date().toISOString(),
    complete: counts.pending === 0 && counts.total > 0,
    // One status string, so the page and the markdown cannot word it differently.
    status: counts.total === 0
      ? 'nothing to review'
      : counts.pending === 0
        ? 'review complete'
        : `${counts.pending} of ${counts.total} still open`
  };
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The handoff a reviewer would paste into a ticket or a pull request. */
export function reportMarkdown(report) {
  const { change, counts, groups, generatedAt, status } = report;
  const lines = [];
  lines.push(`# Impact review: ${change.label}`, '');
  lines.push(`Changed clause: \`${change.target}\` in ${change.document}, version ${change.version}.`, '');
  lines.push(`Status: ${status}. Generated ${generatedAt} by ChangeTrail.`, '');
  lines.push('## What changed', '');
  lines.push(`- Now: ${change.targetText}`);
  if (change.replacementText) lines.push(`- Proposed: ${change.replacementText}`);
  else lines.push('- Proposed: no replacement wording was registered with this change');
  lines.push('');

  lines.push('## Clauses that follow it', '');
  if (counts.total === 0) {
    lines.push('No clause depends on this one through a confirmed link. This is a result, not a failure: nothing downstream references it.', '');
  }
  for (const group of groups) {
    if (!group.items.length) continue;
    lines.push(`### ${group.label} (${group.items.length})`, '');
    for (const item of group.items) {
      lines.push(`- **${item.document}**, \`${item.id}\``);
      lines.push(`  - ${item.hops.length - 1} confirmed link${item.hops.length === 2 ? '' : 's'} from the changed clause: ${item.path.join(' to ')}`);
      for (const hop of item.hops.slice(0, -1)) {
        lines.push(`  - evidence: "${hop.quote}" (${hop.clauseId})`);
      }
      if (item.decision) {
        lines.push(`  - decided by ${item.decision.reviewer}: ${item.decision.reason}`);
      }
    }
    lines.push('');
  }

  lines.push('## Method', '');
  lines.push('Every link above was confirmed by a person against the source wording. Suggested pairs that share wording but were never confirmed are not included, and neither are clauses that merely repeat the same number for a different process.');
  lines.push('');
  return lines.join('\n');
}
