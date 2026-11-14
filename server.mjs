import { createServer } from 'node:http';
import { readFile, copyFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openStore } from './src/graph.mjs';
import { review } from './src/clauses.mjs';
import { getChange, listChanges, reviewQueue, queueCounts, evidenceSummary, listClauses, listDocuments } from './src/workbench.mjs';
import { importDocuments, confirmLink, addChange, openSuggestions, dismissSuggestion } from './src/import.mjs';
import { buildReport, reportMarkdown } from './src/report.mjs';
import { indexPage, changePage, notFoundPage, importPage, linksPage, newChangePage, reportPage } from './src/ui.mjs';

const PORT = Number(process.env.PORT ?? 4173);
const ROOT = resolve('.');
const PRISTINE = resolve('data/imported.rl');
// Relate allows one writing process per store, so the path is configurable and
// a second server needs its own copy rather than sharing this one.
const WORKING = resolve(process.env.STORE ?? '.work/workbench.rl');
const STYLES = { '/app.css': 'app.css', '/tokens.css': 'tokens.css', '/base.css': 'base.css' };

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// The committed store stays pristine; the server reviews a working copy so a
// clone always starts from the same queue.
if (!(await exists(WORKING))) {
  await mkdir(resolve(WORKING, '..'), { recursive: true });
  await copyFile(PRISTINE, WORKING);
  console.log(`Seeded working store from ${PRISTINE}`);
}

const conn = openStore(WORKING);

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readForm(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && STYLES[path]) {
    const css = await readFile(resolve(ROOT, 'public', STYLES[path]), 'utf8');
    return send(res, 200, css, 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && path === '/') {
    return send(res, 200, indexPage({
      changes: listChanges(conn),
      summary: evidenceSummary(conn)
    }));
  }

  // The handoff. Both routes read the same report object the screen renders.
  const reportMatch = /^\/change\/([^/]+)\/report(\.md)?$/.exec(path);
  if (req.method === 'GET' && reportMatch) {
    const changeId = decodeURIComponent(reportMatch[1]);
    const report = buildReport(conn, changeId);
    if (!report) return send(res, 404, notFoundPage(`No change is registered under ${changeId}.`));
    const markdown = reportMarkdown(report);
    if (reportMatch[2]) {
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="impact-review-${changeId.replace(/[^A-Za-z0-9._-]/g, '-')}.md"`,
        'cache-control': 'no-store'
      });
      return res.end(markdown);
    }
    return send(res, 200, reportPage({ report, markdown }));
  }

  if (req.method === 'GET' && path.startsWith('/change/')) {
    const changeId = decodeURIComponent(path.slice('/change/'.length));
    const change = getChange(conn, changeId);
    if (!change) return send(res, 404, notFoundPage(`No change is registered under ${changeId}.`));
    const queue = reviewQueue(conn, changeId);
    const wanted = url.searchParams.get('c');
    const selected = queue.find(item => item.id === wanted) ?? queue[0] ?? null;
    return send(res, 200, changePage({ change, queue, counts: queueCounts(queue), selected, error: null }));
  }

  if (req.method === 'GET' && path === '/import') {
    return send(res, 200, importPage({
      documents: listDocuments(conn),
      notice: url.searchParams.get('ok'),
      error: null
    }));
  }

  if (req.method === 'POST' && path === '/import') {
    const form = await readForm(req);
    const kept = {
      documentId: form.get('documentId') ?? '',
      version: form.get('version') ?? '',
      text: form.get('text') ?? ''
    };
    try {
      const clauses = importDocuments(conn, [kept]);
      res.writeHead(303, {
        location: `/import?ok=${encodeURIComponent(`${clauses.length} clause${clauses.length === 1 ? '' : 's'} added from ${kept.documentId} ${kept.version}. No link was created.`)}`
      });
      return res.end();
    } catch (error) {
      return send(res, 400, importPage({
        documents: listDocuments(conn), notice: null, form: kept,
        error: `Document was not imported. ${error.message}`
      }));
    }
  }

  if (req.method === 'GET' && path === '/links') {
    const clauses = listClauses(conn);
    const all = openSuggestions(conn);
    const showingAll = url.searchParams.get('all') === '1';
    // Strongest wording overlap first; the rest stays one click away rather
    // than filling the page with ten near-identical decisions.
    const strong = all.filter(s => s.run >= 4);
    const shown = showingAll ? all : (strong.length ? strong : all);
    return send(res, 200, linksPage({
      suggestions: shown,
      clausesById: new Map(clauses.map(c => [c.id, c])),
      notice: url.searchParams.get('ok'),
      error: null,
      showingAll,
      hiddenCount: showingAll ? 0 : Math.max(0, all.length - shown.length)
    }));
  }

  if (req.method === 'POST' && path === '/link') {
    const form = await readForm(req);
    const a = form.get('a') ?? '';
    const b = form.get('b') ?? '';
    const reviewer = form.get('reviewer') ?? '';
    const reason = form.get('reason') ?? '';
    const action = form.get('action') ?? '';
    const fail = (message) => {
      const clauses = listClauses(conn);
      return send(res, 400, linksPage({
        suggestions: openSuggestions(conn).filter(s => s.run >= 4),
        clausesById: new Map(clauses.map(c => [c.id, c])),
        notice: null,
        error: message,
        showingAll: false,
        hiddenCount: 0
      }));
    };
    try {
      if (action === 'dismiss') {
        dismissSuggestion(conn, { a, b, reviewer, reason: reason || 'Shared wording, no dependency' });
      } else if (action === 'confirm') {
        const direction = form.get('direction') ?? '';
        if (!['ab', 'ba'].includes(direction)) return fail('Decision was not recorded. Choose which clause depends on the other.');
        // The stored quote must be the wording that made the pair a candidate,
        // not the whole clause, so a reviewer sees exactly what linked them.
        const suggestion = openSuggestions(conn).find(s => s.a === a && s.b === b);
        if (!suggestion) return fail('Decision was not recorded. That pair is no longer an open suggestion.');
        const from = direction === 'ab' ? a : b;
        const to = direction === 'ab' ? b : a;
        const quote = direction === 'ab' ? suggestion.quoteA : suggestion.quoteB;
        confirmLink(conn, { from, to, quote, reviewer });
      } else {
        return fail('Decision was not recorded. Choose an action.');
      }
    } catch (error) {
      return fail(`Decision was not recorded. ${error.message}`);
    }
    res.writeHead(303, { location: `/links?ok=${encodeURIComponent('Decision recorded.')}` });
    return res.end();
  }

  if (req.method === 'GET' && path === '/changes/new') {
    return send(res, 200, newChangePage({
      clauses: listClauses(conn),
      notice: url.searchParams.get('ok'),
      error: null
    }));
  }

  if (req.method === 'POST' && path === '/changes') {
    const form = await readForm(req);
    const kept = {
      id: form.get('id') ?? '',
      label: form.get('label') ?? '',
      target: form.get('target') ?? '',
      replacement: form.get('replacement') ?? ''
    };
    try {
      addChange(conn, {
        id: kept.id,
        label: kept.label,
        target: kept.target,
        replacement: kept.replacement || null
      });
    } catch (error) {
      return send(res, 400, newChangePage({
        clauses: listClauses(conn), notice: null, form: kept,
        error: `Change was not registered. ${error.message}`
      }));
    }
    res.writeHead(303, { location: `/change/${encodeURIComponent(kept.id)}` });
    return res.end();
  }

  if (req.method === 'POST' && path === '/review') {
    const form = await readForm(req);
    const changeId = form.get('changeId') ?? '';
    const clauseId = form.get('clauseId') ?? '';
    const change = getChange(conn, changeId);
    if (!change) return send(res, 404, notFoundPage(`No change is registered under ${changeId}.`));
    const queue = reviewQueue(conn, changeId);
    const selected = queue.find(item => item.id === clauseId) ?? null;
    try {
      review(conn, {
        changeId,
        clauseId,
        status: form.get('status') ?? '',
        reason: form.get('reason') ?? '',
        reviewer: form.get('reviewer') ?? ''
      });
    } catch (error) {
      const refreshed = reviewQueue(conn, changeId);
      const stillSelected = refreshed.find(item => item.id === clauseId) ?? null;
      return send(res, 400, changePage({
        change, queue: refreshed, counts: queueCounts(refreshed),
        selected: stillSelected,
        form: {
          reason: form.get('reason') ?? '',
          reviewer: form.get('reviewer') ?? '',
          status: form.get('status') ?? ''
        },
        error: `Decision was not recorded. ${error.message}`
      }));
    }
    res.writeHead(303, { location: `/change/${encodeURIComponent(changeId)}?c=${encodeURIComponent(clauseId)}` });
    return res.end();
  }

  return send(res, 404, notFoundPage(`${path} is not a page in this app.`));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ChangeTrail workbench: http://127.0.0.1:${PORT}`);
  console.log(`Reading ${WORKING}`);
});
