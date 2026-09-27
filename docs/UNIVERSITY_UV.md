# University Agent: Universitat de València Aula Virtual

This adapter turns the generic University Agent into a read-only daily workflow for Universitat de València Aula Virtual (Moodle).

## Privacy model

The repository contains no personal course registry, assignment history, grades, filenames submitted by the user, session cookies, tokens or credentials.

Private runtime state belongs only on the user's MSI under:

`~/.local/state/engineering-orchestrator/university`

The directory is created with mode `0700` and JSON state files are written with mode `0600`.

The local files are:

- `uv-registry.json`: academic course IDs/codes and read-only course URLs.
- `uv-observations.json`: first-seen material observations and course activity counts.
- `uv-snapshot.json`: normalized current academic snapshot.
- `uv-study-history.json`: recent recommendations used to rotate study work.
- `uv-daily-report.json`: current daily plan.
- `uv-mail-state.json`: bounded deduplication state for already-scanned UV mail.
- `uv-academic-signals.json`: still-active academic obligations extracted from relevant mail.
- `uv-academic-profile.json`: current subject, theory-group and discovered practical-group profile.
- `uv-grades.json`: current-year grade baseline used only to detect later changes.
- `uv-attention.json`: minimal high-value delta flag (`required` + bounded reasons) for the desktop agent.

None of these files should be committed or copied into Cloud State.

## Browser boundary

A dedicated Chrome profile is authenticated manually by the user. Chrome DevTools remains bound to Windows loopback.

The WSL agent invokes a fixed Windows helper. Allowed navigation is restricted to the configured HTTPS university origin and these read routes:

- `/my/courses.php`
- `/course/view.php`
- `/calendar/view.php`
- `/grade/report/overview/index.php`
- read views for `assign`, `forum`, `resource`, `folder`, `page`, `book` and `quiz`

The same dedicated browser profile may also contain an authenticated `https://sogo.uv.es` tab. Mail access uses a separate bounded read-only action and never exposes cookies, passwords or session tokens to WSL.

URLs containing a Moodle `sesskey` are rejected. Mutation routes are not allowed.

The bridge exposes bounded page URL, title, visible body text and same-origin links. It does not expose cookies, local/session storage, authorization headers, password fields or browser profile files.

## Daily scan

`node scripts/university-uv-daily.js`

The scan:

1. loads or bootstraps the private course registry;
2. scans each registered academic course;
3. checks the Moodle calendar for assignment deadlines;
4. opens assignment read views to determine deadline and submission state;
5. records course materials and preserves their first-seen timestamp;
6. compares the normalized snapshot with the previous scan;
7. prioritizes open assignments and new academic changes;
8. scans the authenticated UV SOGo inbox by header, filters mail against the current academic year, subject and personal group, and reads bodies only for relevant candidates;
9. restores the original read/unread state after relevant-message inspection;
10. keeps future tests, mandatory sessions, coursework and schedule changes active after the source email stops being new;
11. reads the current-year grade overview and reports only changes after the private baseline exists;
12. promotes imminent academic obligations into the study plan before filling remaining capacity with rotating study tasks;
13. restores the dedicated Aula Virtual browser to `Mis cursos`.

The default target is six tasks. It may be changed with `UNIVERSITY_DAILY_TASK_TARGET` from 1 to 20.

## Local monitor

On the MSI the scan can run as the user-level `engineering-orchestrator-university.service`, triggered by `engineering-orchestrator-university.timer`. The deployed timer refreshes roughly hourly while the machine is available. Standard output is discarded so private report contents are not copied into the journal; failures go to the user journal for diagnosis.

Each pass rewrites `uv-attention.json`. It becomes `required: true` only for a new relevant mail, a grade change, or an added/updated assignment. Routine unchanged scans therefore remain silent.

## Study planning

When no deadline requires attention, the planner does not return an empty day. It favors current practice/problem material, seminars and topic notes; downranks old exams, administrative manuals and recently recommended files; and initially spreads work across different subjects.

The planner is deterministic and needs no paid model/API call.

## Failure behavior

If the university session expires, the scan fails closed and requires the user to sign in again manually. It never persists login credentials.

If the browser or Windows helper is unavailable, the scan fails rather than silently treating the university as having no work.

Assignment submission, message sending, enrollment changes, grade mutation and other write actions are outside this adapter. Grade access is read-only and private; the agent only compares the current-year overview with its previous local baseline.
