export function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Escape text, marking the exact quoted span the reviewer is being shown. */
export function marked(text, quote) {
  if (!quote) return esc(text);
  const at = text.indexOf(quote);
  if (at < 0) return esc(text);
  return `${esc(text.slice(0, at))}<mark>${esc(quote)}</mark>${esc(text.slice(at + quote.length))}`;
}

/** Word-level diff between the current and proposed clause text. */
export function diffWords(before, after) {
  const tokenize = s => String(s).match(/\s+|[^\s]+/g) ?? [];
  const a = tokenize(before);
  const b = tokenize(after);
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const beforeParts = [];
  const afterParts = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      beforeParts.push(esc(a[i]));
      afterParts.push(esc(b[j]));
      i++; j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      beforeParts.push(`<del>${esc(a[i])}</del>`);
      i++;
    } else {
      afterParts.push(`<ins>${esc(b[j])}</ins>`);
      j++;
    }
  }
  while (i < rows) beforeParts.push(`<del>${esc(a[i++])}</del>`);
  while (j < cols) afterParts.push(`<ins>${esc(b[j++])}</ins>`);
  return { before: beforeParts.join(''), after: afterParts.join('') };
}

const STATE = { confirmed: 'Confirmed', dismissed: 'Dismissed', pending: 'Needs review' };

/**
 * The impact trace: a real diagram of this review's dependency path, generated
 * from the same hop data the list below shows. Two layouts so it never needs
 * JavaScript to reflow: wide (nodes along a line) and tall (nodes down a spine).
 */
function traceDiagram(hops) {
  const n = hops.length;
  if (n === 0) return '';
  const last = n - 1;

  // Wide: nodes laid along a shallow curve, labels beneath.
  const w = 1000;
  const padX = 96;
  const gap = n === 1 ? 0 : (w - padX * 2) / (n - 1);
  const y = 74;
  const xs = hops.map((_, i) => padX + gap * i);
  const wideNodes = hops.map((hop, i) => {
    const x = xs[i];
    const isEnd = i === last;
    const bend = i === 0 ? 0 : 26;
    const path = i === 0 ? '' :
      `<path class="t-edge" style="--i:${i}" d="M ${xs[i - 1]} ${y} C ${xs[i - 1] + gap * 0.4} ${y - bend}, ${x - gap * 0.4} ${y - bend}, ${x} ${y}"/>`;
    return `${path}
      <g class="t-node${isEnd ? ' t-node--end' : ''}" style="--i:${i}">
        <circle cx="${x}" cy="${y}" r="${isEnd ? 7 : 5.5}"/>
        <text class="t-name" x="${x}" y="${y + 30}" text-anchor="middle">${esc(hop.document)}</text>
        <text class="t-meta" x="${x}" y="${y + 46}" text-anchor="middle">${isEnd ? 'changed here' : `link ${i + 1}`}</text>
      </g>`;
  }).join('');

  const wide = `<svg class="trace trace--wide" viewBox="0 0 ${w} 132" role="img"
      aria-label="Impact trace: ${esc(hops.map(h => h.document).join(' depends on '))}, ending at the changed clause">
      ${wideNodes}
    </svg>`;

  // Tall: the same path down a spine, for narrow screens.
  const step = 64;
  const tallNodes = hops.map((hop, i) => {
    const yy = 34 + step * i;
    const isEnd = i === last;
    const edge = i === 0 ? '' :
      `<path class="t-edge" style="--i:${i}" d="M 22 ${yy - step + 8} L 22 ${yy - 8}"/>`;
    return `${edge}
      <g class="t-node${isEnd ? ' t-node--end' : ''}" style="--i:${i}">
        <circle cx="22" cy="${yy}" r="${isEnd ? 7 : 5.5}"/>
        <text class="t-name" x="40" y="${yy + 4}">${esc(hop.document)}</text>
        <text class="t-meta" x="40" y="${yy + 19}">${isEnd ? 'changed here' : `link ${i + 1}`}</text>
      </g>`;
  }).join('');

  const tall = `<svg class="trace trace--tall" viewBox="0 0 320 ${34 + step * last + 34}" role="img"
      aria-label="Impact trace down a spine, ending at the changed clause">
      ${tallNodes}
    </svg>`;

  return `<div class="trace-wrap">${wide}${tall}</div>`;
}

function layout({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Extra+Condensed:wght@200;400&family=Barlow:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <div class="bar__inner">
    <a class="bar__mark" href="/">ChangeTrail</a>
    <p class="bar__note">Document impact review, run on a local Relate store</p>
    <nav class="bar__nav" aria-label="Workbench">
      <a href="/">Changes</a>
      <a href="/import">Add documents</a>
      <a href="/links">Confirm links</a>
      <a href="/changes/new">Register change</a>
    </nav>
  </div>
</header>
<main class="shell">
${body}
</main>
</body>
</html>`;
}

export function indexPage({ changes, summary }) {
  const rows = changes.map(c => `
      <tr>
        <td class="sheet__name">
          <a href="/change/${esc(c.id)}">${esc(c.label)}</a>
          <span class="sheet__sub">${esc(c.document)} ${esc(c.version)}</span>
        </td>
        <td class="sheet__clause">${esc(c.targetText)}</td>
        <td class="sheet__count">${c.impacts === 0 ? 'nothing follows' : `${c.impacts} follow${c.impacts === 1 ? 's' : ''}`}</td>
        <td class="sheet__end"><span class="sheet__end-label">Replacement </span>${esc(c.replacement ? 'version 2' : 'none')}</td>
      </tr>`).join('');

  const body = `
<section class="poster">
  <h1>What changed, and which documents follow it</h1>
  <p class="poster__lead">Pick a change, read the clauses that depend on it, and record what needs review. Every link was confirmed by a person and keeps its source quote.</p>
</section>

<section class="edition" aria-label="Store evidence">
  <div class="edition__cell">
    <p class="edition__figure">${esc(summary.clauses)}</p>
    <p class="edition__label">clauses imported</p>
  </div>
  <div class="edition__cell">
    <p class="edition__figure edition__figure--lit">${esc(summary.confirmed)}</p>
    <p class="edition__label">confirmed dependencies</p>
  </div>
  <div class="edition__cell">
    <p class="edition__figure">${esc(summary.suggested)}</p>
    <p class="edition__label">suggested, never trusted</p>
  </div>
</section>

<section class="block">
  <h2 class="block__head">Open changes</h2>
  ${changes.length ? `<table class="sheet">
    <thead><tr><th scope="col">Change</th><th scope="col">Changed clause</th><th scope="col">Follows</th><th scope="col">Replacement</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<p class="empty">No change is registered in this store. Add one with addChange before reviewing.</p>`}
</section>`;

  return layout({ title: 'ChangeTrail, open changes', body });
}

export function changePage({ change, queue, counts, selected, error, form }) {
  const diff = change.replacementText
    ? diffWords(change.targetText, change.replacementText)
    : null;
  // A rejected submit must not wipe what the reviewer typed.
  const kept = { reason: '', reviewer: '', status: '', ...(form ?? {}) };

  const rows = queue.map((item, index) => `
      <li>
        <a class="queue-row${item.id === selected?.id ? ' is-current' : ''}" style="--i:${index}" href="/change/${esc(change.id)}?c=${esc(item.id)}">
          <span class="queue-row__num">${String(index + 1).padStart(2, '0')}</span>
          <span class="queue-row__body">
            <span class="queue-row__name">${esc(item.document)}</span>
            <span class="queue-row__meta">${esc(item.hops.length - 1)} link${item.hops.length === 2 ? '' : 's'} from the changed clause</span>
          </span>
          <span class="queue-row__state queue-row__state--${esc(item.state)}">${esc(STATE[item.state] ?? item.state)}</span>
        </a>
      </li>`).join('');

  const stations = selected ? selected.hops.map((hop, i) => {
    const isEnd = i === selected.hops.length - 1;
    return `<li class="station${isEnd ? ' station--end' : ''}" style="--i:${i}">
      <p class="station__num">${String(i + 1).padStart(2, '0')}</p>
      <div class="station__body">
        <p class="station__doc">${esc(hop.document)}</p>
        <p class="station__id">${esc(hop.clauseId)}</p>
        <p class="station__text">${isEnd ? esc(hop.text) : marked(hop.text, hop.quote)}</p>
      </div>
    </li>`;
  }).join('') : '';

  const history = selected?.history?.length ? `<ul class="history">
    ${selected.history.map(h => `<li>
      <p class="history__head">
        <span class="history__seq">${esc(h.seq)}</span>
        <span class="history__state history__state--${esc(h.status)}">${esc(STATE[h.status] ?? h.status)}</span>
        <span class="history__who">${esc(h.reviewer)}</span>
      </p>
      <p class="history__reason">${esc(h.reason)}</p>
      <p class="history__at">${esc(h.at)}</p>
    </li>`).join('')}
  </ul>` : `<p class="empty">No decision recorded yet for this clause.</p>`;

  const detail = selected ? `
  <section class="detail" aria-labelledby="detail-head">
    <div class="detail__head">
      <h2 id="detail-head">${esc(selected.document)}</h2>
      <span class="detail__state detail__state--${esc(selected.state)}">${esc(STATE[selected.state] ?? selected.state)}</span>
      <span class="detail__id">${esc(selected.id)}</span>
    </div>

    <h3 class="detail__sub">Impact trace</h3>
    ${traceDiagram(selected.hops)}

    <h3 class="detail__sub">Why this clause is in the queue</h3>
    <p class="detail__note">Read down from this clause to the one that changed. The highlighted wording in each station is the quote a person confirmed when they recorded the link.</p>
    <ol class="route">${stations}</ol>

    <form class="decide" method="post" action="/review">
      <h3 class="detail__sub">Decide</h3>
      <input type="hidden" name="changeId" value="${esc(change.id)}">
      <input type="hidden" name="clauseId" value="${esc(selected.id)}">
      <div class="choices" role="group" aria-label="Outcome for this clause">
        <label class="choice">
          <input type="radio" name="status" value="confirmed" required${kept.status === 'confirmed' ? ' checked' : ''}>
          <span class="choice__label">Confirm it needs an edit</span>
          <span class="choice__hint">The clause has to change too</span>
        </label>
        <label class="choice">
          <input type="radio" name="status" value="dismissed"${kept.status === 'dismissed' ? ' checked' : ''}>
          <span class="choice__label">Dismiss, no edit needed</span>
          <span class="choice__hint">It still holds after the change</span>
        </label>
        <label class="choice">
          <input type="radio" name="status" value="pending"${kept.status === 'pending' ? ' checked' : ''}>
          <span class="choice__label">Leave open for someone else</span>
          <span class="choice__hint">Hand it on with your note</span>
        </label>
      </div>
      <div class="fields">
        <label class="field">
          <span class="field__label">Reason, kept with the decision</span>
          <textarea name="reason" rows="3" required placeholder="What did you check, and what did you find?">${esc(kept.reason)}</textarea>
        </label>
        <label class="field">
          <span class="field__label">Your name</span>
          <input name="reviewer" type="text" required value="${esc(kept.reviewer || selected.decision?.reviewer || '')}" autocomplete="name">
        </label>
      </div>
      ${error ? `<p class="banner" role="alert">${esc(error)}</p>` : ''}
      <button class="btn btn--primary" type="submit">Record decision</button>
    </form>

    <div class="block">
      <h3 class="detail__sub">Decision history</h3>
      ${history}
    </div>
  </section>` : `<section class="detail">
    <h2>No candidate selected</h2>
    <p class="empty">Pick a clause from the queue to see its impact trace and record a decision.</p>
  </section>`;

  const body = `
<section class="poster poster--tight">
  <h1>${esc(change.label)}</h1>
  <p class="poster__meta">${esc(change.target)} in ${esc(change.document)}, version ${esc(change.version)}</p>
  <p class="poster__meta"><a href="/change/${esc(change.id)}/report">Hand off this review as a list</a></p>
</section>

<section class="block">
  <h2 class="block__head">What changed</h2>
  ${diff
    ? `<div class="diff">
        <div class="diff__col">
          <p class="diff__label">Now in version ${esc(change.version)}</p>
          <p class="diff__text">${diff.before}</p>
        </div>
        <div class="diff__col diff__col--next">
          <p class="diff__label">Proposed in version 2</p>
          <p class="diff__text">${diff.after}</p>
        </div>
      </div>`
    : `<div class="diff diff--single">
        <div class="diff__col">
          <p class="diff__label">The clause as it stands</p>
          <p class="diff__text">${esc(change.targetText)}</p>
        </div>
        <p class="diff__none">No replacement wording is stored for this change, so the reviewer judges the impact from the clause text.</p>
      </div>`}
</section>

<section class="workbench">
  <div class="queue">
    <div class="queue__head">
      <h2 class="block__head">Queue</h2>
      <p class="queue__counts">${counts.total} total, ${counts.pending} open, ${counts.confirmed} confirmed, ${counts.dismissed} dismissed</p>
      <div class="meter" role="img" aria-label="${counts.total === 0 ? 'nothing in the queue' : `${counts.confirmed + counts.dismissed} of ${counts.total} settled`}">
        <span class="meter__fill" style="--fill:${counts.total === 0 ? 0 : (counts.confirmed + counts.dismissed) / counts.total}"></span>
      </div>
    </div>
    ${queue.length ? `<ul class="queue__list">${rows}</ul>` : `<p class="empty">No clause depends on this one through a confirmed link, so the queue is empty. That is a real answer, not a loading state.</p>`}
  </div>
  <div>
    ${detail}
  </div>
</section>`;

  return layout({ title: `ChangeTrail, ${change.label}`, body });
}

export function importPage({ documents, notice, error, form }) {
  const kept = { documentId: '', version: '', text: '', ...(form ?? {}) };
  const rows = documents.map(d => `
      <tr>
        <td>${esc(d.document)}</td>
        <td>${esc(d.version)}</td>
        <td class="sheet__count">${esc(d.clauses)} clause${d.clauses === 1 ? '' : 's'}</td>
      </tr>`).join('');

  const body = `
<section class="poster poster--tight">
  <h1>Add a document</h1>
  <p class="poster__meta">Paragraphs become clauses. Importing creates no links, so nothing enters a queue until a person confirms it.</p>
</section>

${notice ? `<p class="notice-line" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="banner" role="alert">${esc(error)}</p>` : ''}

<section class="block">
  <form class="form" method="post" action="/import">
    <div class="fields">
      <label class="field">
        <span class="field__label">Document id</span>
        <input name="documentId" type="text" required value="${esc(kept.documentId)}" placeholder="incident-policy" pattern="[A-Za-z0-9._-]+">
      </label>
      <label class="field">
        <span class="field__label">Version</span>
        <input name="version" type="text" required value="${esc(kept.version)}" placeholder="1" pattern="[A-Za-z0-9._-]+">
      </label>
    </div>
    <label class="field">
      <span class="field__label">Text, one paragraph per clause</span>
      <textarea name="text" rows="10" required placeholder="Incident notification policy. Notify the response lead within 72 hours.&#10;&#10;The response lead must acknowledge the notification.">${esc(kept.text)}</textarea>
    </label>
    <button class="btn btn--primary" type="submit">Import document</button>
  </form>
</section>

<section class="block">
  <h2 class="block__head">In this store</h2>
  ${documents.length ? `<table class="sheet">
    <thead><tr><th scope="col">Document</th><th scope="col">Version</th><th scope="col">Clauses</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<p class="empty">No document is imported yet. Paste one above to start.</p>`}
</section>`;

  return layout({ title: 'ChangeTrail, add a document', body });
}

export function linksPage({ suggestions, clausesById, notice, error, hiddenCount, showingAll }) {
  const rows = suggestions.map((s, index) => {
    const a = clausesById.get(s.a) ?? { document: s.a, text: '', id: s.a };
    const b = clausesById.get(s.b) ?? { document: s.b, text: '', id: s.b };
    return `<li class="suggest" style="--i:${index}">
      <div class="suggest__head">
        <span class="suggest__index">${String(index + 1).padStart(2, '0')}</span>
        <span class="suggest__count">${esc(s.run)} shared words</span>
      </div>
      <div class="suggest__pair">
        <div class="suggest__side">
          <p class="suggest__doc">${esc(a.document)}</p>
          <p class="suggest__id">${esc(a.id)}</p>
          <p class="suggest__quote">${marked(a.text, s.quoteA)}</p>
        </div>
        <div class="suggest__side">
          <p class="suggest__doc">${esc(b.document)}</p>
          <p class="suggest__id">${esc(b.id)}</p>
          <p class="suggest__quote">${marked(b.text, s.quoteB)}</p>
        </div>
      </div>
      <form class="suggest__form" method="post" action="/link">
        <input type="hidden" name="a" value="${esc(s.a)}">
        <input type="hidden" name="b" value="${esc(s.b)}">
        <div class="choices choices--pair" role="group" aria-label="Which clause depends on the other">
          <label class="choice">
            <input type="radio" name="direction" value="ab" required>
            <span class="choice__label">${esc(a.document)} depends on ${esc(b.document)}</span>
          </label>
          <label class="choice">
            <input type="radio" name="direction" value="ba">
            <span class="choice__label">${esc(b.document)} depends on ${esc(a.document)}</span>
          </label>
        </div>
        <div class="fields fields--pair">
          <label class="field">
            <span class="field__label">Your name</span>
            <input name="reviewer" type="text" required autocomplete="name">
          </label>
          <label class="field">
            <span class="field__label">Note, kept only if you dismiss</span>
            <input name="reason" type="text" placeholder="Shared wording, unrelated process">
          </label>
        </div>
        <div class="actions">
          <button class="btn btn--primary" type="submit" name="action" value="confirm">Record dependency</button>
          <button class="btn" type="submit" name="action" value="dismiss">Dismiss this pair</button>
        </div>
      </form>
    </li>`;
  }).join('');

  const body = `
<section class="poster poster--tight">
  <h1>Confirm what depends on what</h1>
  <p class="poster__meta">These pairs share wording. Shared wording is not a dependency, so each one needs a person to set the direction or rule it out.</p>
</section>

${notice ? `<p class="notice-line" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="banner" role="alert">${esc(error)}</p>` : ''}

<section class="block">
  <h2 class="block__head">Open suggestions</h2>
  ${suggestions.length ? `<ul class="suggestions">${rows}</ul>` : `<p class="empty">No undecided suggestion is left. Import another document to find more, or open a change to review the confirmed ones.</p>`}
  ${hiddenCount > 0 ? `<p class="more"><a href="/links?all=1">Show ${hiddenCount} weaker suggestion${hiddenCount === 1 ? '' : 's'}</a>, which share fewer words.</p>` : ''}
  ${showingAll ? `<p class="more"><a href="/links">Show only the stronger suggestions</a></p>` : ''}
</section>`;

  return layout({ title: 'ChangeTrail, confirm links', body });
}

export function newChangePage({ clauses, notice, error, form }) {
  const kept = { id: '', label: '', target: '', replacement: '', ...(form ?? {}) };
  const options = clauses.map(c =>
    `<option value="${esc(c.id)}"${c.id === kept.target ? ' selected' : ''}>${esc(c.document)} ${esc(c.version)}, clause ${esc(c.ordinal ?? '')}</option>`).join('');
  const replacementOptions = clauses.map(c =>
    `<option value="${esc(c.id)}"${c.id === kept.replacement ? ' selected' : ''}>${esc(c.document)} ${esc(c.version)}, clause ${esc(c.ordinal ?? '')}</option>`).join('');

  const body = `
<section class="poster poster--tight">
  <h1>Register a change</h1>
  <p class="poster__meta">Pick the clause that changed. A replacement clause is optional, and must come from a different version.</p>
</section>

${notice ? `<p class="notice-line" role="status">${esc(notice)}</p>` : ''}
${error ? `<p class="banner" role="alert">${esc(error)}</p>` : ''}

<section class="block">
  ${clauses.length ? `<form class="form" method="post" action="/changes">
    <div class="fields">
      <label class="field">
        <span class="field__label">Change id</span>
        <input name="id" type="text" required value="${esc(kept.id)}" placeholder="deadline-24h" pattern="[A-Za-z0-9._-]+">
      </label>
      <label class="field">
        <span class="field__label">What changed, in a few words</span>
        <input name="label" type="text" required value="${esc(kept.label)}" placeholder="Notification deadline 72 hours to 24 hours">
      </label>
    </div>
    <label class="field">
      <span class="field__label">Clause that changed</span>
      <select name="target" required>${options}</select>
    </label>
    <label class="field">
      <span class="field__label">Replacement clause, optional</span>
      <select name="replacement"><option value="">No replacement wording</option>${replacementOptions}</select>
    </label>
    <button class="btn btn--primary" type="submit">Register change</button>
  </form>` : `<p class="empty">No clause is imported yet, so there is nothing to change. Add a document first.</p>`}
</section>`;

  return layout({ title: 'ChangeTrail, register a change', body });
}

export function reportPage({ report, markdown }) {
  const { change, counts, groups, generatedAt, complete, status } = report;

  const section = (group) => {
    if (!group.items.length) return '';
    const rows = group.items.map(item => `
        <li class="report__item">
          <p class="report__item-head">
            <span class="report__doc">${esc(item.document)}</span>
            <span class="report__id">${esc(item.id)}</span>
          </p>
          <p class="report__path">${item.path.map((id, i) =>
            `${esc(id)}${i < item.path.length - 1 ? ' depends on ' : ''}`).join('')}</p>
          <ul class="report__evidence">
            ${item.hops.slice(0, -1).map(hop =>
              `<li>&ldquo;${esc(hop.quote)}&rdquo; <span class="report__from">in ${esc(hop.clauseId)}</span></li>`).join('')}
          </ul>
          ${item.decision ? `<p class="report__decision">${esc(item.decision.reviewer)}: ${esc(item.decision.reason)}</p>` : ''}
        </li>`).join('');
    return `
    <section class="report__group">
      <h2 class="report__group-head">${esc(group.label)} <span class="report__count">${group.items.length}</span></h2>
      <ul class="report__items">${rows}</ul>
    </section>`;
  };

  const body = `
<section class="poster poster--tight">
  <h1>Impact review</h1>
  <p class="poster__meta">${esc(change.label)}</p>
</section>

<section class="block report-meta">
  <p class="report-meta__status ${complete ? 'is-complete' : ''}">
    ${esc(status)}
  </p>
  <p class="report-meta__line">Changed clause <span class="report__id">${esc(change.target)}</span> in ${esc(change.document)}, version ${esc(change.version)}. Generated ${esc(generatedAt)}.</p>
  <p class="report-meta__line">${esc(change.targetText)}</p>
  ${change.replacementText ? `<p class="report-meta__line report-meta__next">${esc(change.replacementText)}</p>` : ''}
  <div class="actions">
    <a class="btn" href="/change/${esc(change.id)}/report.md" download>Download as Markdown</a>
    <a class="btn" href="/change/${esc(change.id)}">Back to the review</a>
  </div>
</section>

${counts.total === 0
  ? `<p class="empty">No clause depends on this one through a confirmed link. Nothing downstream references it, so there is nothing to hand off.</p>`
  : groups.map(section).join('')}

<section class="block">
  <h2 class="block__head">How this list was made</h2>
  <p class="report__method">Every link above was confirmed by a person against the source wording, and the quote is printed with it. Pairs that share wording but were never confirmed are left out, and so are clauses that repeat the same number for a different process. The graph is traversed only along confirmed edges, up to eight hops.</p>
  <details class="report__raw">
    <summary>Markdown source</summary>
    <pre class="report__pre">${esc(markdown)}</pre>
  </details>
</section>`;

  return layout({ title: `ChangeTrail, impact review for ${change.label}`, body });
}

export function notFoundPage(message) {  return layout({
    title: 'ChangeTrail, not found',
    body: `<section class="poster">
      <h1>That page is not in the store</h1>
      <p class="poster__lead">${esc(message)}</p>
      <p><a href="/">Back to open changes</a></p>
    </section>`
  });
}
