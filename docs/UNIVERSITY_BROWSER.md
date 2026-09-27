# University authenticated browser bridge

This bridge is for a dedicated local Chrome profile that the user authenticates manually.

The agent connects only to a Chrome DevTools endpoint on loopback and only exposes pages whose HTTPS origin is explicitly allowlisted. It can list those tabs and read the current page URL, title and bounded visible body text.

It deliberately has no interface for cookies, local storage, session storage, authorization headers, password fields, form filling, clicking, assignment submission, messages or enrollment changes.

Recommended Windows launch pattern:

chrome.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --user-data-dir="<dedicated-university-profile>"

Use a dedicated university profile rather than an everyday personal browser profile. Sign in manually in that profile. A provider-specific parser can then convert the sanitized page text into the University Agent snapshot model.

If the session expires, the bridge must stop and require manual re-authentication rather than persisting credentials.
