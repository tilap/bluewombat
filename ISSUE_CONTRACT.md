# Writing Features and Tickets on GitHub: the contract

Temporary document. It tells whoever (or whatever) creates the issues what the
system reads, what it does with it, and what follows from each choice. It is
sourced from `packages/plugins/manager-github` and `packages/host/runtime`;
what has only run against mocked HTTP is said so (§ 9).

## 1. What the system does, in one paragraph

It builds software from issues, unattended. A **Feature** is an issue that says
what is wanted. Its **Tickets** are its sub-issues: each one is a single unit of
work that one coding agent does in one go. The system takes one Feature at a
time per Project. It opens a branch `feature/<id>` for it, does the Tickets one
after the other, each in its own pull request onto that branch (checked by
gates, then merged), and finally opens one pull request from the Feature
branch to the final branch. A human merges that last pull request, unless the
Feature carries `merge-when-ready`.

The system does **not** split work, **not** write issues, **not** validate
that the plan is a good one. Everything it does is decided by what is written
in the issues. A bad Ticket produces bad work, silently.

## 2. The shape

```
Feature  (issue, label feature-ready)
 ├─ Ticket A  (sub-issue, label task-ready)
 ├─ Ticket B  (sub-issue, label task-ready, blocked by A)
 └─ Ticket C  (sub-issue, label task-ready, blocked by B)
```

- One repository holds the Feature and its Tickets. Tickets are the **native
  GitHub sub-issues** of the Feature (parent link), not a task list in the body
  and not issues that merely mention it.
- Only direct sub-issues count. A sub-issue of a sub-issue is not read.
- At most 1000 Tickets are read per Feature (10 pages of 100).
- A pull request listed among the sub-issues is ignored.

## 3. Labels

| Label | On | Meaning | Who sets it |
| --- | --- | --- | --- |
| `feature-ready` | Feature | The Feature's content is final and its Tickets may be written. **Only issues with this label are listed at all.** | the creator, last |
| `task-ready` | each Ticket | The Ticket's specification is final | the creator, on all Tickets together, after the list was validated |
| `merge-when-ready` | Feature | The final pull request may be merged without a human | the creator, or a human |
| `to-resume` | Feature or Ticket | Resume after an escalation | a human |
| `project:<name>` | Feature | The Project the work belongs to. A Ticket takes its Feature's Project, whatever its own labels say. Missing: the configured default Project | the creator |
| `priority:<n>` | Feature and Ticket | `0`–`100`, or `low` 25, `normal` 50, `high` 75, `urgent` 100. Missing: 50 | the creator |
| `mason:*` | any | State labels the system writes. **Do not set or remove them** | the system |

The label names above are the defaults. `feature-ready` and `task-ready` may be given
the same name (for example `ready-for-agent` for both): a Feature is a
top-level issue, a Ticket is a sub-issue, so the same label is read on each
side without confusion.

The names are options of the manager, each under the side that reads it:
`featureReadyLabel` and `mergeWhenReadyLabel` under `featureTracker`,
`ticketReadyLabel` under `ticketTracker`, and `resumeLabel` under both.
`mason setup --apply` creates them on the repository.

## 4. The Feature issue

**Title.** Counts twice: it is the intention when the body is empty, and it is
part of what the system compares to know whether the issue changed. It is also
the title of the final pull request, `(#N)` appended and a trailing full stop
dropped. Write a real title.

**Body.** The intention, word for word, less the HTML comments a template
leaves and the boxes of task lists (`- [ ]` keeps its bullet and words). The
system reads **no structure**: no headings, no checklist, no acceptance
criteria are extracted. For a Feature the body is the statement of the need and
the final pull request's text. It is not what the agent codes from (that is the
Tickets), so write it for the reviewer who will merge the result: what is
wanted, why, what is out of scope.

**Refused (`invalid`, said once in a comment, nothing starts):**
- no title and no body;
- more than one `project:` label, or none and no default Project configured;
- more than one `priority:` label, or a value outside the scale;
- it is a pull request.

**Order between Features.** Highest `priority`, then oldest, among the Features
not blocked.

**Dependencies between Features.** Use GitHub's native *Blocked by* on the
Feature issue. A Feature opens only when every Feature blocking it is `done`
in the system's ledger. Closing the blocker by hand on GitHub does **not**
unblock anything.

**One at a time.** A Project has at most one open Feature. While it is being
made, escalated, or waiting for a human to merge its pull request, no other
Feature starts on that Project.

## 5. The Ticket issue (sub-issue)

A Ticket is the unit of work. One coding agent run per attempt (with up to a
few repair attempts), then gates, then a pull request. It is not split further.

**Title and body.** The body is **the agent's task, verbatim**. The title is
the fallback when the body is empty and the title of the Ticket's pull request.
The agent has the repository and nothing else: it does not see the Feature, the
other Tickets, or this document. Therefore each Ticket body must:

- be **self-contained**: say what to change and where it matters, in the
  repository's own words;
- state **observable outcomes** (what a person or a test can check), because
  that is what the reviewing agent and the checks judge, not intentions;
- leave the repository's own checks **green on its own**: the Ticket is merged
  into the Feature branch as soon as it passes, before the next one starts, so
  no Ticket may rely on a later one to compile or pass;
- be small enough for one run: one behaviour, one slice.

No acceptance-criteria field exists: say it in the body. Boxes in the body are
fine and are not read as edits when ticked.

**Project.** Always the Feature's.

**Priority.** `priority:` label, default 50. It only orders Tickets that are
both ready and unblocked within the Feature.

**Dependencies between Tickets.** Native *Blocked by* on the sub-issue. A
Ticket starts only when all its blockers are `done` in the ledger. Among the
Tickets that can start: highest priority, then oldest. If nothing can start
while Tickets remain (a cycle, or a blocker that was cancelled), the Feature
**escalates**.

**A Ticket the system cannot read is dropped silently** from the list rather
than refused: two `priority:` labels, no title and no body, or a bad value. The
Feature would then proceed without it. Validate before labelling.

## 6. When does work start (the start rule)

A Feature opens when **all** of these hold:

1. it carries `feature-ready`;
2. every Feature blocking it is `done`;
3. no other Feature is open on the Project;
4. it has at least one Ticket, and **every** Ticket carries `task-ready`.

Consequences for the creator:

- The Tickets are read **once, when the Feature opens**. A Ticket added later
  is ignored and the Feature closes without it.
- A Feature whose Tickets are not all `task-ready` just waits; nothing is made.
- Recommended order of creation, so nothing opens on a half-written list:
  1. create the Feature **without** `feature-ready`;
  2. create all Tickets as sub-issues, with their blockers and priorities;
  3. have a human validate the list;
  4. add `task-ready` to every Ticket, together;
  5. add `feature-ready` to the Feature, last.

## 7. What the system writes back

- Comments on the issues, each ending with a machine marker (`<!-- ticket-event
  … -->`): accepted, progress ("Landed 1 of 3: …"), escalated, done, cancelled,
  invalid. A comment that states a fact is written once.
- The `mason:*` state labels.
- Branches `feature/<id>` and `issue/<id>`, pull requests onto them, squash
  merges. A Ticket's pull request body is its intention and `Closes #N`; the
  Feature's final pull request has the Feature's.
- **A Ticket issue is not closed** when its pull request merges into the
  Feature branch (GitHub honours `Closes` only for the default branch). The
  Feature issue is closed by the final merge.
- A creator that watches issues must ignore these comments and labels.

## 8. Edits, escalations, cancellation

- **Comments you or anyone write are never read as instructions.** The system
  only reads its own comments, to avoid repeating itself.
- **Editing an issue:** while a Feature is waiting (or a Ticket has not
  started) the new words are taken. Once work has started on it the edit is
  **not applied** and does not interrupt the work. To change running work,
  close it and write a new issue.
- **Escalation.** When the system cannot go on (a gate keeps refusing, a pull
  request is refused, the agent says it is blocked) it comments with the
  reason and stops that Project. A human fixes the cause and adds `to-resume`.
  Nothing else starts on that Project meanwhile.
- **Abandon.** Closing an issue cancels it; closing a Feature cancels its
  unfinished Tickets and drops its branch. Deleting is read the same way.
- **Human merge.** Without `merge-when-ready` the system opens the final pull
  request and waits for a person to merge it. Closed without merging: it
  escalates.

## 9. Known limits, so the creator does not rely on what is not there

- Edits after work started are ignored (§ 8); the system's own claim that it
  freezes and asks a human does not hold for Features today.
- Only `done` in the ledger unblocks a dependency.
- Tickets joining after the Feature opened are ignored.
- A Feature none of whose Tickets landed escalates; one that lost some of them
  lands without them.
- This flow has run on one real repository for one Feature of one Ticket. The
  chains of blockers, `merge-when-ready`, two Features in a row, a refused
  final pull request and abandon in flight are covered by tests with simulated
  GitHub only.
- Cross-repository sub-issues and blockers are not handled.

## 10. Checklist for the creator

For a Feature:
- [ ] a real title; a body that says what and why, for a reviewer;
- [ ] `project:<name>` (or the configured default applies); at most one `priority:`;
- [ ] *Blocked by* set if another Feature must land first;
- [ ] `feature-ready` added **last**, after all Tickets carry `task-ready`.

For each Ticket:
- [ ] it is a native sub-issue of the Feature;
- [ ] a title, and a self-contained body with observable outcomes;
- [ ] it leaves the project's checks green when merged alone;
- [ ] *Blocked by* set to the Tickets it needs, with no cycle;
- [ ] at most one `priority:` label;
- [ ] `task-ready` added together with its siblings.
