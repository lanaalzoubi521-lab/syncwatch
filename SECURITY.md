# Security

## Data handling

- Exports and workflow files are read in the browser. Nothing is uploaded or stored on a server.
- The public build ships with a Content Security Policy that blocks network requests (fetch, XHR, WebSocket) and all remote code. It reduces, but does not remove, the impact of an injected script, which is why every value is also escaped before display.
- The investigation agent runs only when the page is opened inside Claude, on the viewer's own account, after the viewer allows it.

## Secrets

- The scan covers the whole workflow: node parameters, notes, header and query pairs, JSON bodies stored as strings, and pinned or static data. It matches by key name (Authorization, x-api-key, token, secret, password and similar) and by value shape (Bearer, Basic, Shopify tokens, sk- keys, JSON web tokens), case-insensitively. n8n expressions such as `{{ $credentials... }}` are references, not secrets, and are not flagged.
- Findings show type, place and length, never any part of the value.
- The agent receives a copy of the workflow with every secret replaced by `[REDACTED]`, pinned and static data removed, and free text clipped. Tests plant secrets in each of these places and check that none of their characters reach the audit output or the agent.

## The agent

- Read-only: its four tools return data and change nothing. Fixes are applied only through the human approval step.
- Prompt injection: product names, node names and notes reach the agent only inside tool results, clipped. The prompt tells it to treat tool results as data and ignore instructions inside them, and the symptom text is length-limited and quote-escaped. Because the tools are read-only, the worst case is a misleading report, never a change.

## Hardening covered by tests

| Threat | Handling |
|---|---|
| Script injection through product names or file contents | All values are escaped before reaching the page. Tested with hostile CSV input. |
| Formula injection in generated CSV files | Cells starting with `=`, `+`, `-`, `@` are prefixed so spreadsheets treat them as text. |
| Oversized files | Files over 20 MB or 200,000 rows are refused. |
| Malformed workflow files | Rejected with a clear message unless they contain an n8n `nodes` array. |

## Reporting

Please report a vulnerability by email to lanaalzoubi521@gmail.com rather than opening a public issue.
