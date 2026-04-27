# Tool Payload Audit

Goal: identify Gmail and Outlook Composio tools that are likely to explode agent context, and produce concrete post-processing recommendations for each risky tool.

What I tried:
- Looking only at tool slugs and descriptions
- Reusing app code directly
- Scanning all Outlook raw tools without filtering to mail-specific tools

What failed:
- Slugs and descriptions alone miss important risk flags such as `format=full`, `format=raw`, `include_payload=true`, Outlook `select=body`, MIME download paths, and attachment-content fields
- App-local formatters are useful reference, but they do not cover Outlook and they are not a good standalone audit surface
- The broad Outlook inventory includes calendar and chat tools, which adds noise if the audit is supposed to focus on email payload risk

Solution:
- Load live raw Composio tool definitions for `gmail` and `outlook`
- Inspect the input/output schemas and descriptions for payload-risk signals
- Filter Outlook down to mail-related tools before scoring
- Rank risky tools and emit concrete post-processing guidance
- Write both JSON and Markdown reports into `output/`

Current focus:
- Gmail list, message, thread, attachment, and history tools
- Outlook list, search, message, MIME-content, attachment, and delta tools

How to run:

```bash
cp testscripts/2026.04.27-tool-payload-audit/.env.example testscripts/2026.04.27-tool-payload-audit/.env
pnpm --dir testscripts/2026.04.27-tool-payload-audit run run
```

Required env:

```bash
COMPOSIO_API_KEY=...
RAW_TOOL_LIMIT=500
```

Outputs:
- `output/payload-risk-report.json`
- `output/payload-risk-summary.md`

Current results:
- Gmail highest-risk tools are `GMAIL_LIST_THREADS`, `GMAIL_FETCH_EMAILS`, `GMAIL_LIST_DRAFTS`, `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`, and `GMAIL_GET_ATTACHMENT`
- Outlook highest-risk tools are `OUTLOOK_GET_CHILD_FOLDER_MESSAGE_CONTENT`, `OUTLOOK_GET_MESSAGE`, `OUTLOOK_GET_MAIL_FOLDER_MESSAGE`, `OUTLOOK_GET_ME_MESSAGE_MIME_CONTENT`, `OUTLOOK_LIST_MESSAGES`, `OUTLOOK_GET_MAIL_DELTA`, and Outlook attachment list/download tools
- The common failure mode is the same across both toolkits: full body content, raw MIME, attachment bytes, and multi-message thread/list expansions are too large for replay-safe agent memory
- The recommended fix is also the same: keep message summaries, plain text body, metadata, and file references only; drop raw MIME, HTML, payload parts, and binary content

Notes:
- This is a draft investigation script, not a repo test
- The script is intentionally standalone from app logic, but it resolves `@composio/core` from the installed workspace dependency so it can run without adding new local installs
- The report is heuristic by design: it flags the tools most likely to overfetch based on live schemas and descriptions, then recommends how to compact them for agent use
