# University Agent

University Agent is an isolated, read-only academic lane built on the shared desktop-agent core.

## First slice

The initial contract deliberately does not perform authentication or browser actions. A future browser connector may use an authenticated local browser profile, but it must pass only sanitized academic data into the University Agent state model.

The state stores subjects, announcements, assignments, materials and timestamps. It rejects credential-like fields and keeps a stable source identity so data from different university systems cannot be silently mixed.

The deterministic planner converts open assignments and newly detected announcements/materials into a daily task queue. Deadlines are prioritized before reading tasks. No model call is required for the baseline priority order.

## Safety boundary

This lane must not store passwords, cookies, authorization headers, access tokens or refresh tokens in repository files or durable cloud state.

The read-only adapter has no methods for submitting assignments, sending messages, changing enrollment, changing grades, deleting material or performing any other irreversible action.

Any future authenticated browser integration must keep its browser session outside durable University Agent state and must introduce explicit human approval before write actions are added.

## Next integration step

Add a provider-specific browser reader that opens the user's already-authenticated university portal, extracts a sanitized snapshot, and feeds it into the adapter. The connector should detect login/session expiry and stop for human re-authentication rather than storing credentials.
