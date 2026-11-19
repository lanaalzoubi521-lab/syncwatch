# Security

## Data handling

- Exports and workflow files are read in the browser. Nothing is uploaded or stored on a server.
- The public build ships with a Content Security Policy that blocks every network request, so uploaded data cannot leave the page even if a script were injected.
- The investigation agent runs only when the page is opened inside Claude, on the viewer's own account, after the viewer allows it.

## Secrets

- The workflow audit reports secrets it finds (type, node, length) and never displays any part of the value.
- The agent receives the workflow with every token replaced by `[REDACTED]`. Tests check that no secret characters reach the audit output or the agent.

## The agent

- Read-only: its four tools return data and change nothing. Fixes are applied only through the human approval step.
- Prompt injection: product names and other customer data reach the agent inside tool results. The prompt tells it to treat tool results as data and ignore any instructions inside them, strings are clipped, and the symptom text is length-limited and quote-escaped.

## Hardening covered by tests

| Threat | Handling |
|---|---|
| Script injection through product names or file contents | All values are escaped before reaching the page. Tested with hostile CSV input. |
| Formula injection in generated CSV files | Cells starting with `=`, `+`, `-`, `@` are prefixed so spreadsheets treat them as text. |
| Oversized files | Files over 20 MB or 200,000 rows are refused. |
| Malformed workflow files | Rejected with a clear message unless they contain an n8n `nodes` array. |

## Reporting

Please report a vulnerability by email to lanaalzoubi521@gmail.com rather than opening a public issue.
