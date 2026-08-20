# n8n-nodes-openbox-hook

OpenBox governance community node for n8n.

This package provides an **OpenBox: Agent** node that wraps n8n LangChain chat models, memory, and tools with OpenBox governance — policy evaluation, PII redaction, HITL approval, and audit traces — without changing your existing workflow structure.

## Install

In n8n, open **Settings > Community Nodes**, choose **Install**, and enter:

```
n8n-nodes-openbox-hook
```

Restart n8n if prompted.

## Credentials

Create an **OpenBox API** credential in n8n with:

| Field | Required | Description |
|---|---|---|
| **API Base URL** | Yes | OpenBox Core API base URL. Point it at your own deployment if self-hosting. |
| **API Key** | Yes | Your OpenBox API key. Live keys start with `obx_live_`; test keys with `obx_test_`. |
| **Agent DID** | No | Agent decentralised identifier (`did:aip:<uuid>`). Required only for agents with `signing_required = true`. |
| **Agent Private Key** | No | Base64-encoded raw 32-byte Ed25519 seed. Paired with Agent DID for signed requests. |

Get your API key from [dashboard.openbox.ai](https://dashboard.openbox.ai).

## Usage

### Basic setup

1. Add an **OpenBox: Agent** node to your workflow.
2. Connect a **Chat Model** sub-node (e.g. OpenAI Chat Model, Anthropic Chat Model) to the **Chat Model** input.
3. Optionally connect **Memory** (max 1) and any number of **Tool** sub-nodes.
4. Attach your **OpenBox API** credential to the node.

That is the whole required setup — there is no agent name or task queue to fill
in. The node exposes the same inputs and outputs as the standard n8n AI Agent
node, so it is a drop-in replacement.

The agent identity reported to OpenBox is derived from the node itself:

- **agent name** — `n8n.Agent.<Node_Name>`, with spaces replaced by underscores. Renaming the node in the canvas renames the agent in your traces.
- **task queue** — always `n8n`.

### Example workflow

```
[Chat Trigger]
      │
      ▼
[OpenBox: Agent]  ←──  [OpenAI Chat Model]
      │            ←──  [Window Buffer Memory]
      │            ←──  [Calculator Tool]
      ▼
[Set node / downstream steps]
```

When the agent runs, OpenBox evaluates each LLM call and tool invocation
against your configured policies. If a call requires approval (HITL), the node
pauses and polls until a decision is received.

### Fallback model

Enable **Enable Fallback Model** to expose a second **Fallback Model** input.
If the primary chat model fails, the agent retries on the fallback. Both models
are governed identically.

### Options

Standard agent behaviour lives under **Options**: `System Message`,
`Max Iterations`, `Enable Streaming`, `Return Intermediate Steps`,
`On Tool Error`, and `Automatically Passthrough Binary Images`.

### Advanced Governance

Governance behaviour lives in the **Advanced Governance** collection. Defaults
are chosen so the node is useful without configuration.

| Option | Default | Description |
|---|---|---|
| **Governance Events to Send** | all six | Which lifecycle events are evaluated: workflow started/completed, LLM started/completed, tool started/completed. |
| **On API Error** | Fail Open | Whether an unreachable OpenBox API lets the workflow continue ungoverned, or stops it. |
| **Governance Request Timeout (Seconds)** | `30` | HTTP timeout for calls to the OpenBox Core API. |
| **Tools to Exclude From Governance** | *(none)* | Comma-separated tool names whose calls are never governed. |
| **Human-in-the-Loop Approval Enabled** | `true` | Whether the node pauses for approval when a policy demands it. |
| **Approval Poll Interval (Seconds)** | `5` | How often to poll for an approval decision. |
| **Approval Max Wait (Seconds)** | `3600` | How long to wait before halting. `0` waits indefinitely. |
| **Instrument HTTP Calls** | `true` | Capture outgoing HTTP calls (e.g. to the LLM provider) as governance spans. |
| **Instrument Databases** | `true` | Capture database queries made during tool execution as spans. |
| **Database Drivers to Instrument** | all five | Which drivers to patch: `pg`, `mysql2`, `mongodb`, `redis`, `ioredis`. |
| **Instrument File I/O** | `false` | Capture file reads/writes during tool execution as spans. |

### Spans

With instrumentation enabled, each governed activity carries spans for the work
it performed — HTTP requests, database queries, and file operations — as a
`started` / `completed` pair sharing one span id, so the dashboard can show real
durations. Spans are only recorded for work that runs inside a governed
activity's async context; unrelated I/O elsewhere in the n8n process is not
captured.

### Advanced: Agent DID signing

For agents configured with `signing_required = true` in OpenBox, fill in the
**Agent DID** and **Agent Private Key** fields in the credential. Every request
to the OpenBox API will be signed with an Ed25519 signature automatically.

## Package layout

```text
custom-node/
  nodes/OpenBoxAgent/
    OpenBoxAgent.node.ts        the OpenBox: Agent node
    openbox.svg                 node icon
  credentials/
    OpenBoxApi.credentials.ts   the OpenBox API credential
  shared/
    openbox-client.ts           signed HTTP client for the Core API
    signing.ts                  Ed25519 request signing
    credential-test.ts          credential connectivity check
    langchain/
      middleware.ts             governance middleware around the agent
      hooks.ts, hook_handlers.ts, tool_hook.ts
      span_processor.ts         activity scope + span lifecycle
      node_instrumentation.ts   http / db / file patches
      hitl.ts                   human-in-the-loop polling
      verdict.ts, config.ts, client.ts, error-info.ts, types.ts
  tests/                        vitest suites
  scripts/                      build helpers (clean, copy assets)
```

`main` and the `n8n` manifest point into `dist/`, which is built on `prepack`
and is not checked in.

## Local development

```bash
npm install
npm run build
npm test
npm run lint
```

To verify the package scan passes before publishing:

```bash
npx @n8n/scan-community-package n8n-nodes-openbox-hook
```

Release process is documented in [RELEASING.md](../RELEASING.md).
