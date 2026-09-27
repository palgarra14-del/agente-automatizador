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

None of these files should be committed or copied into Cloud State.

## Browser boundary

A dedicated Chrome profile is authenticated manually by the user. Chrome DevTools remains bound to Windows loopback.

The WSL agent invokes a fixed Windows helper. Allowed navigation is restricted to the configured HTTPS university origin and these read routes:

- `/my/courses.php`
- `/course/view.php`
- `/calendar/view.php`
- read views for `assign`, `forum`, `resource`, `folder`, `page`, `book` and `quiz`

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
8. fills remaining daily capacity with rotating study tasks from active materials;
9. restores the dedicated browser to `Mis cursos`.

The default target is six tasks. It may be changed with `UNIVERSITY_DAILY_TASK_TARGET` from 1 to 20.

## Study planning

When no deadline requires attention, the planner does not return an empty day. It favors current practice/problem material, seminars and topic notes; downranks old exams, administrative manuals and recently recommended files; and initially spreads work across different subjects.

The planner is deterministic and needs no paid model/API call.

## Failure behavior

If the university session expires, the scan fails closed and requires the user to sign in again manually. It never persists login credentials.

If the browser or Windows helper is unavailable, the scan fails rather than silently treating the university as having no work.

Assignment submission, messages, enrollment changes, grade changes and other write actions are outside this adapter.
