# University Agent

University Agent is an isolated, read-only academic lane built on the shared desktop-agent core.

## Current slice

University Agent now uses an authenticated local browser profile through a Windows-loopback CDP bridge. The browser session remains outside durable agent state; only sanitized academic data crosses into WSL.

The UV adapter reads current subjects, assignments, materials, calendar deadlines, relevant SOGo mail, discovered theory/practical groups and the current-year grade overview. Mail is filtered by academic year, subject and personal group before body inspection, and unread state is restored after read-only inspection. Grade scans establish a private baseline and emit only later changes.

The deterministic planner prioritizes deadlines, imminent assessments and course-specific work before rotating useful study material. Durable academic signals retain future obligations after the source email is no longer new. No paid model/API call is required for the baseline priority order.

## Safety boundary

This lane must not store passwords, cookies, authorization headers, access tokens or refresh tokens in repository files or durable cloud state.

The read-only adapter has no methods for submitting assignments, sending messages, changing enrollment, changing grades, deleting material or performing any other irreversible action.

The authenticated browser session remains outside durable University Agent state. Any future write-capable integration must introduce explicit human approval before write actions are added.

## Next integration step

Keep the local scan fresh with a bounded user-level scheduler and connect only high-value deltas to the desktop agent's attention surface. Session expiry must still stop for manual re-authentication rather than storing credentials.
