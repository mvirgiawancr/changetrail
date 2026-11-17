# Devpost submission draft

Copy from here into the Devpost form. Every claim below is checked against the
repository; nothing here is aspirational.

## Basics

- **Project name:** ChangeTrail
- **Tagline (one line):** When a rule changes, find every document that has to change with it, and show the evidence for each one.
- **Repo:** https://github.com/mvirgiawancr/changetrail
- **Built with:** Relate 1.0.0 (Neo4j embedded graph database), Node.js 22+, openCypher, no framework on the server.
- **Repository topic:** add `relate` and `neo4j` as topics on the GitHub repo, since the rules ask for a topic tag.

## Inspiration

Operational documents are not independent. A policy states a deadline. An SOP
points at the policy instead of restating it. A checklist says "follow the SOP".
A training slide repeats the old number.

When the policy changes, the SOP may still be correct while the training slide is
now wrong. A text search cannot tell those apart: it finds the documents that
repeat the old number, and misses the ones that reference it.

## What it does

ChangeTrail is a local review workbench. You import documents, confirm which
clause depends on which, register a change to one clause, and then review the
downstream clauses a person can see are affected. Every relationship in the graph
was confirmed by a human and keeps the exact wording that justified it.

Five screens, in the order a reviewer works: import, confirm links, register a
change, review, and a handoff report.

## How it uses Relate

- **Single-file mode.** Each demo store is one `.rl` file committed to the repo,
  so a judge can inspect the graph without starting a service. `:memory:` was
  rejected because the data would vanish; a directory store adds files without
  adding anything this demo needs.
- **The graph:** `Clause`, `Change` and `SuggestionDecision` nodes;
  `DEPENDS_ON`, `CHANGES`, `PROPOSES` and `REVIEWED` relationships. A dependency
  edge carries the `quote` that justifies it, its `provenance`, the reviewer and
  the time.
- **The query that matters:** impact traversal follows `DEPENDS_ON` up to eight
  hops and accepts a path only when **every** edge is `manually-confirmed`. A
  suggested pair is never an edge, so it can never reach a review queue.
- **A proposed replacement clause is stored beside the change**, not rewired into
  the graph, so recording a proposal cannot silently change what depends on what.
- **No server, no API key, no model call** is needed to run anything.

## The moment that proves it

Changing the incident notification deadline from 72 hours to 24 hours:

| | Confirmed graph | Literal text search |
| --- | --- | --- |
| The SOP that points at the policy | yes | yes |
| The checklist that never repeats the number | **yes** | **missed** |
| The training slide with the old number | yes | yes |
| The equipment-returns paragraph that also says "72 hours" | **no** | **false positive** |

`npm run spike` prints both side by side from the committed store.

## What was hard

Two things are easy to get wrong and both are visible in the code:

1. **Suggestion is not evidence.** Lexical overlap finds candidates, and that is
   all it does. It returns `direction: 'undetermined'` and is never written as an
   edge. A dismissal is stored as a decision, so a reviewer's rejection is
   recorded rather than forgotten.
2. **Two versions of one document are not a dependency.** A version bump is a
   supersession. The first build suggested version 1 and version 2 of the same
   policy as linked, which would have put obsolete text in a review queue; the
   suggestion step now skips same-document pairs entirely.

## Challenges

- **Relate 1.0.0 is a week old.** It shipped 11 November 2026. The Node binding
  works on Windows, but transactions are `conn.begin()` / `commit()`, not Cypher
  `BEGIN`, and the docs are still thin. Every API call in this repo was verified
  against the actual package rather than the docs.
- **Making the honesty structural.** It would be trivial to claim automatic
  detection. Instead the graph physically cannot hold an inferred dependency: the
  traversal filters on provenance, so the only way to add an edge is to name a
  reviewer and quote the source wording.

## What we learned

- A review tool's value is not the answer it gives, it is whether a second person
  can check the answer. That is why every link carries its quote and the handoff
  report prints the path, not just the conclusion.
- Graph databases earn their place when the *path* is the deliverable. A single
  hop would fit in a table; three hops with a different quote at each one is a
  graph.

## What's next

Passage-level impact (deciding whether the changed sentence actually affects the
dependent clause, not just that a dependency exists), PDF and heading-aware
import, and authentication so the audit trail records identity rather than a typed
name.

## Built with

`relate`, `neo4j`, `opencypher`, `node.js`, `javascript`, `css`

## Checklist before submitting

- [x] Public GitHub repo with setup instructions in the README
- [x] Persistent Relate store committed and inspectable (`data/*.rl`)
- [x] Working code with Relate actually running, 35 tests
- [x] Repository topics added: `relate`, `neo4j`, `graph-database`, `opencypher`, `document-review`
- [ ] Demo video, 1 to 2 minutes
- [ ] Video uploaded and linked on the submission form
