# SyncWatch

**Your integration says "Success". SyncWatch checks whether the data agrees.**

Most ERP to e-commerce integrations fail quietly. The workflow runs on schedule, every run is green, and meanwhile the store shows last month's prices, new products never appear, and online orders never reach finance. Nothing throws an error, so nothing gets fixed.

SyncWatch watches the outcome instead of the run log. It replays the sync, reconciles both systems record by record, reads the workflow file, and reports every place where the data and the "Success" status disagree, with the evidence, the business impact in AED, the root cause, and the exact change to make.

![Overview](docs/overview.png)

## The demo

*Raml Home*, a fictional Dubai homeware retailer, syncs Microsoft Dynamics 365 Finance & Operations to Shopify with an n8n workflow. It went live on 1 October 2026 and has reported 197 successful runs with zero errors. SyncWatch finds four silent failures:

| # | What the data shows | Root cause |
|---|---|---|
| 1 | 18 ERP products never reached the store | A `Limit` node set to 50, left in from testing |
| 2 | 73 products show the wrong price or stock, with stock oversold and items sold below the ERP price | The ERP query filters on `CreatedDateTime` with a fixed date, so edits to existing products are never fetched |
| 3 | 171 Shopify orders have no sales order in the ERP | The workflow has no write-back step |
| 4 | An ERP access token is stored in plain text | The token sits in an HTTP header instead of n8n's credential store |

These are the same four classes of issue found in a real production review of a Dynamics 365 to Shopify integration.

## How it works

**Detectors look only at evidence a monitor can actually see:** the run log, the two systems, and the exported workflow JSON. Each detector needs a pattern, not a single symptom. The date-filter detector, for example, only fires when more than 90% of drifted products were created before go-live and edited after it.

**Fixes are replayed, not assumed.** Approving a fix changes the workflow configuration, replays every scheduled run since go-live, and reconciles again. When one fix also clears another finding, SyncWatch says so. Every approval is logged.

**An investigation agent** (when the page runs inside Claude) takes a symptom in plain words, such as *"customers see old prices"*, and works it out with four read-only tools: `get_run_log`, `compare_systems`, `get_workflow`, and `get_product`. It reports causes with the numbers it found. It cannot change anything. Changes go through the human approval step.

## Run it

No dependencies. Node 18 or later.

```bash
npm test          # 8 engine tests
npm run build     # writes dist/index.html, one self-contained file
```

## Structure

```
src/data.js     demo world: ERP products, Shopify state at go-live, orders, schedule, workflow JSON
src/engine.js   replay, reconciliation, the four detectors, secret scanning
src/agent.js    agent tools and prompt
src/app.js      interface
test/           node:test suite
```

## Author

Lana Alzoubi · AI & Automation · [lanaalzoubi.com](https://lanaalzoubi.com)

MIT License.
