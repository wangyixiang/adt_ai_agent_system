# CLIENT_SPEC.md

# AI Client Specification

**Version:** 0.2
**Status:** Draft
**Role:** User Interaction + Local Capability / Execution Runtime

---

## 1. Overview

AI Client is the user's local interaction and execution endpoint in the Central AI Orchestration architecture.

The Client is responsible for:

1. interacting with the user;
2. exposing locally available capabilities;
3. executing the current Step requested by the Server;
4. interacting with local services, tools, agents, devices, and applications;
5. collecting execution results and Evidence;
6. handling Human-in-the-loop interaction;
7. reporting execution state and Evidence back to the Server.

The Client is **not** responsible for:

* global workflow planning;
* deciding the next Step;
* maintaining an independent workflow planner;
* performing autonomous LLM-based re-planning;
* executing an entire workflow locally;
* replacing the Server's Workflow Engine.

The core model is:

```text
                    Central Server
                         │
                  Plan one Step
                         │
                         ▼
                  ┌──────────────┐
                  │ AI Client    │
                  │              │
                  │ UI           │
                  │ Capability   │
                  │ Runtime      │
                  │ Execution    │
                  └──────┬───────┘
                         │
              Local Services / Agents
              Tools / Devices / Apps
                         │
                         ▼
                      Evidence
                         │
                         ▼
                    Central Server
                         │
                     Re-plan
                         │
                         ▼
                    Next Step
```

The fundamental execution loop is:

```text
Plan
  ↓
One Step
  ↓
Execute
  ↓
Observe
  ↓
Evidence
  ↓
Re-plan
  ↓
One Step
```

---

# 2. Design Principles

## 2.1 Single-Step Dispatch

The Server MUST NOT dispatch more than one actionable Step to a Client at a time.

The Client receives:

```text
execution.request
```

for the current Step, executes it, and reports the result.

Only after the Server receives the result may it generate the next Step.

This is a core protocol invariant.

```text
Server
  │
  │ Step N
  ▼
Client
  │
  │ result/evidence
  ▼
Server
  │
  │ Step N+1
  ▼
Client
```

The Server SHOULD NOT send:

```text
Step N
Step N+1
Step N+2
Step N+3
```

as an executable batch.

This prevents stale plans and keeps planning synchronized with the latest Evidence.

---

## 2.2 Client Is Execution-Oriented

The Client should be rich in local capabilities but intentionally limited in global intelligence.

Conceptually:

```text
Server:
    "What should happen next?"

Client:
    "I can execute this."

Server:
    "What actually happened?"

Client:
    "Here is the result and Evidence."
```

---

## 2.3 Server Is the Planning Authority

The Client MUST NOT independently decide the next workflow Step.

Even if a local agent or LLM exists inside the Client, it MUST NOT modify the authoritative Server workflow state without an explicit protocol operation.

Local agents MAY help execute a Step.

They do not become the global Workflow Engine.

---

## 2.4 Workflow State Is Server-Owned

The Client may report:

* execution started;
* execution waiting;
* execution completed;
* execution failed;
* execution cancelled;
* Evidence collected.

The Server owns the authoritative Workflow state.

The Client MUST NOT independently transition the global workflow into:

```text
COMPLETED
FAILED
CANCELLED
```

unless the protocol explicitly defines the Client event as the input that causes the Server to perform that transition.

---

# 3. Responsibilities

## 3.1 Client Responsibilities

The Client is responsible for:

### User Interaction

* conversation UI;
* workflow UI;
* displaying current Step;
* requesting user input;
* displaying execution status;
* displaying Evidence;
* requesting confirmation where required.

### Capability Management

* discovering local capabilities;
* exposing capability metadata;
* registering capabilities with Server;
* detecting capability changes;
* enabling/disabling capabilities;
* enforcing local capability permissions.

### Execution

* receiving one Step;
* validating whether it can execute;
* invoking the required local capability;
* monitoring execution;
* collecting output;
* reporting execution state.

### Evidence

* collecting command output;
* collecting logs;
* collecting screenshots;
* collecting files;
* collecting device data;
* collecting structured results;
* collecting human-generated information.

### Human-in-the-loop

* presenting interaction requests;
* collecting user input;
* collecting confirmations;
* reporting user responses;
* associating responses with the current Step.

---

# 4. Non-Responsibilities

The Client MUST NOT become responsible for:

* global workflow planning;
* global context composition;
* knowledge-base retrieval;
* global RAG;
* selecting the next Step;
* deciding whether the overall problem is solved;
* maintaining the authoritative workflow state;
* autonomous workflow re-planning;
* silently changing Server-issued Steps.

A Client MAY contain local intelligence, but such intelligence is subordinate to the Server workflow protocol.

---

# 5. Client Architecture

A reference architecture:

```text
┌─────────────────────────────────────────────┐
│                  AI Client                  │
│                                             │
│  ┌───────────────┐     ┌────────────────┐   │
│  │ User Interface│     │ Session Manager│   │
│  └───────┬───────┘     └───────┬────────┘   │
│          │                     │            │
│          └──────────┬──────────┘            │
│                     ▼                       │
│              Workflow Runtime               │
│                     │                       │
│          ┌──────────┴──────────┐            │
│          ▼                     ▼            │
│   Execution Manager      HITL Manager       │
│          │                     │            │
│          ▼                     ▼            │
│ Capability Registry      User Interaction   │
│          │                                  │
│          ▼                                  │
│ Local Capability Runtime                   │
│          │                                  │
│   ┌──────┼──────────┬──────────┐            │
│   ▼      ▼          ▼          ▼            │
│ Tools  Services    Agents    Devices        │
│                                             │
│                 Evidence Manager            │
│                       │                     │
│                       ▼                     │
│                Central Server               │
└─────────────────────────────────────────────┘
```

---

# 6. Session Management

The Client manages the local user session and its relationship with the Server.

A session MAY contain:

* `session_id`;
* `user_id`;
* `client_id`;
* active workflow references;
* conversation messages;
* capability information;
* connection status.

The Client SHOULD support reconnection without losing the local execution context of an active Step.

The Client SHOULD persist sufficient local information to recover from temporary network failures.

---

# 7. Capability System

The Client exposes its locally available capabilities to the Server.

A capability represents an operation that the Client can execute.

Examples:

```text
filesystem.read
filesystem.write
shell.execute
git.status
git.diff
git.log
browser.open
browser.inspect
device.read
device.configure
camera.capture
diagnostic.run
local_agent.invoke
```

Capabilities MAY be provided by:

* built-in Client functionality;
* local applications;
* local services;
* MCP servers;
* local agents;
* operating-system APIs;
* devices;
* enterprise tools.

---

# 8. Capability Manifest

The Client SHOULD expose a Capability Manifest.

Example:

```json
{
  "client_id": "client_001",
  "capabilities": [
    {
      "id": "git.diff",
      "version": "1.0",
      "description": "Collect current git diff",
      "input_schema": {},
      "output_schema": {},
      "risk_level": "low"
    },
    {
      "id": "shell.execute",
      "version": "1.0",
      "description": "Execute a local shell command",
      "input_schema": {},
      "output_schema": {},
      "risk_level": "high"
    }
  ]
}
```

The Server may use this information during planning.

The capability manifest is descriptive.

It does not grant unrestricted authorization.

---

# 9. Dynamic Capability Discovery

Capabilities MAY change during a workflow.

Examples:

```text
local service started
local service stopped
device connected
device disconnected
MCP server added
permission revoked
agent became unavailable
```

The Client SHOULD notify the Server when the capability set changes.

Example:

```text
capability.updated
```

The Server MUST treat capability information as potentially stale.

Before executing a Step, the Client MUST perform local validation.

---

# 10. Workflow Execution

The Client receives one actionable Step at a time.

Example:

```json
{
  "type": "execution.request",
  "workflow_id": "wf_001",
  "step_id": "step_004",
  "capability": "git.diff",
  "input": {
    "repository": "/workspace/project"
  }
}
```

The Client:

1. validates the request;
2. validates capability availability;
3. validates local permissions;
4. starts execution;
5. reports execution state;
6. collects Evidence;
7. reports the result.

---

# 11. Step State

The Client recognizes the following execution states:

```text
PENDING
RUNNING
WAITING
COMPLETED
FAILED
CANCELLED
```

The Server owns the authoritative state.

The Client reports observations about the current Step.

### PENDING

The Step exists but has not started execution.

### RUNNING

The Step is actively executing.

### WAITING

The current Step cannot continue because it is waiting for an external event.

Examples:

* user input;
* user confirmation;
* device event;
* local service response;
* external resource.

### COMPLETED

The Step completed successfully.

### FAILED

The Step was attempted but could not complete successfully.

### CANCELLED

Execution was explicitly cancelled.

---

# 12. Human-in-the-loop

Human-in-the-loop is an interaction mechanism of the Client, not a workflow-control mechanism.

The Client provides the local user interaction capabilities required by an active Step.

The Server remains responsible for:

* workflow state;
* planning;
* determining the next Step.

The Client is responsible for:

* presenting interaction requests;
* collecting user input;
* reporting the response;
* continuing the current Step;
* reporting Evidence.

## 12.1 Human Interaction Flow

```text
Server
  │
  │ execution.request
  ▼
Client
  │
  │ current Step requires user input
  ▼
User
  │
  │ confirmation / selection / information
  ▼
Client
  │
  │ user.response
  ▼
Server
  │
  │ context update + re-plan
  ▼
Next Step
```

## 12.2 WAITING

Human interaction MAY cause:

```text
RUNNING → WAITING
```

After the required event occurs:

```text
WAITING → RUNNING
```

The Client MUST NOT interpret `WAITING` as workflow-level pause.

There is no required:

```text
pause_workflow
resume_workflow
```

concept.

## 12.3 User Response

Example:

```json
{
  "type": "user.response",
  "workflow_id": "wf_001",
  "step_id": "step_004",
  "request_id": "req_123",
  "response": {
    "type": "confirmation",
    "value": "confirm"
  }
}
```

The Server interprets the response in workflow context.

## 12.4 Human Evidence

Human interaction MAY produce Evidence:

```json
{
  "type": "evidence",
  "workflow_id": "wf_001",
  "step_id": "step_004",
  "source": "human",
  "data": {
    "decision": "confirm"
  }
}
```

Human Evidence SHOULD be distinguishable from automatically collected Evidence.

## 12.5 User Rejection

User rejection does not automatically mean workflow failure.

The Server may decide to:

* generate another Step;
* request additional information;
* retry;
* terminate the workflow.

The Server remains the authority for the resulting workflow state.

---

# 13. Local Execution and Composite Capabilities

A single Server Step MAY invoke a composite local capability.

Example:

```text
Capability:
    git.collect_diagnostics
```

Internally it may execute:

```text
git status
git diff
git log
git branch
```

However, Central still sees:

```text
One Step
    ↓
One Capability Invocation
    ↓
One Result
```

A composite capability MUST have:

* defined input;
* defined output;
* defined failure semantics;
* defined permission requirements.

A composite capability MUST NOT become an opaque representation of an entire workflow.

---

# 14. Evidence

Evidence is the Client's primary output to the Server.

Evidence MAY include:

### Structured data

```json
{
  "cpu_usage": 72,
  "temperature": 65
}
```

### Command output

```text
$ git status
...
```

### Files

```text
diagnostic_report.json
```

### Logs

```text
application.log
```

### Screenshots

```text
screenshot.png
```

### Device information

```json
{
  "device": "camera_01",
  "status": "connected"
}
```

### Human input

```json
{
  "operator_decision": "confirmed"
}
```

---

# 15. Evidence Provenance

Evidence SHOULD contain provenance information.

Example:

```json
{
  "evidence_id": "ev_001",
  "workflow_id": "wf_001",
  "step_id": "step_004",
  "source": "local_tool",
  "capability": "git.diff",
  "timestamp": "2026-09-23T12:00:00Z",
  "data": {}
}
```

This allows the Server to distinguish:

```text
LLM-generated assumption
        vs
actual local observation
```

The Client SHOULD NOT modify Evidence to make it conform to an expected result.

---

# 16. Communication

The Client communicates with the Server through a protocol supporting:

* request/response;
* event streaming;
* execution status;
* Evidence transfer;
* reconnect;
* correlation IDs.

Possible transports:

```text
REST
WebSocket
SSE
gRPC
```

A practical implementation MAY use:

```text
REST:
    session / capability / execution APIs

WebSocket:
    workflow events / execution events / HITL events
```

The transport is replaceable.

The protocol semantics MUST remain independent of transport.

---

# 17. Core Events

### Server → Client

```text
workflow.start
execution.request
user.input.request
workflow.cancel
```

### Client → Server

```text
capability.manifest
capability.updated
execution.started
execution.waiting
execution.completed
execution.failed
execution.cancelled
user.response
evidence
client.status
```

---

# 18. Correlation

Every execution-related message SHOULD contain:

```text
workflow_id
step_id
request_id
client_id
```

This allows the Server and Client to correlate asynchronous events.

Example:

```text
workflow_id = wf_001
step_id     = step_004
request_id  = req_981
```

---

# 19. Idempotency

The Client SHOULD protect against duplicate execution requests.

A repeated:

```text
execution.request
```

with the same execution identifier SHOULD NOT blindly execute the operation twice.

This is especially important for side-effecting operations.

Examples:

```text
device.configure
file.write
shell.execute
database.update
```

The Client SHOULD maintain sufficient execution metadata to determine whether a request has already been accepted or completed.

---

# 20. Security Boundary

The Client is the local security boundary.

The Server cannot assume that a declared capability is automatically executable.

The Client MUST enforce:

* local permissions;
* authentication;
* authorization;
* filesystem restrictions;
* process restrictions;
* device permissions;
* user confirmation requirements;
* enterprise security policies.

For dangerous operations, the Client MAY require explicit Human-in-the-loop confirmation.

---

# 21. Client Failure

Client failures MUST be observable by the Server.

Examples:

```text
network disconnected
local service unavailable
capability disappeared
permission denied
execution timeout
application crashed
device disconnected
user interaction unavailable
```

The Client SHOULD report structured failure information.

Example:

```json
{
  "type": "execution.failed",
  "workflow_id": "wf_001",
  "step_id": "step_004",
  "error": {
    "code": "CAPABILITY_UNAVAILABLE",
    "message": "git service is unavailable"
  }
}
```

The Server determines whether to:

* retry;
* re-plan;
* select another capability;
* request user intervention;
* terminate the workflow.

---

# 22. Cancellation

The Server MAY send:

```text
workflow.cancel
```

The Client SHOULD stop the currently executing Step when safe to do so.

For non-interruptible operations, the Client MAY report that cancellation is pending.

The Client MUST report the final execution state.

---

# 23. Reconnection

Temporary communication loss MUST NOT automatically imply workflow cancellation.

After reconnecting, the Client SHOULD:

1. authenticate again if required;
2. identify the active workflow;
3. identify the current Step;
4. report local execution state;
5. synchronize pending Evidence;
6. resume protocol communication.

The Server remains the source of authoritative workflow state.

---

# 24. Local Agent Integration

The Client MAY integrate local agents.

Examples:

```text
coding agent
diagnostic agent
browser agent
device agent
industrial test agent
```

A local agent is treated as a capability provider.

```text
Server
  ↓
One Step
  ↓
Client
  ↓
Local Agent
  ↓
Result
  ↓
Client
  ↓
Evidence
  ↓
Server
```

The local agent MUST NOT silently create a parallel global workflow.

---

# 25. Non-Goals

The Client is not intended to be:

* a second Central Server;
* a global workflow planner;
* a knowledge-base engine;
* a global RAG system;
* an autonomous multi-step agent;
* the authoritative workflow state store.

The Client may provide local intelligence, but the system remains centrally orchestrated.

---

# 26. MVP

The MVP Client SHOULD implement:

### Core

* user authentication;
* Server connection;
* session management;
* workflow UI;
* single-Step execution;
* execution state reporting;
* Evidence reporting.

### Capability

* static capability manifest;
* capability discovery;
* capability validation;
* local permission checks.

### Human-in-the-loop

* confirmation dialog;
* user input;
* selection;
* user response event;
* WAITING state.

### Communication

* REST or WebSocket;
* correlation IDs;
* reconnect;
* idempotency.

### Local Execution

At least:

```text
shell.execute
filesystem.read
filesystem.write
git.status
git.diff
```

The exact capability set depends on the target environment.

---

# 27. Core Invariants

The following rules are normative.

### Invariant 1

> Client receives and executes one actionable Step at a time.

### Invariant 2

> Client does not decide the next Step.

### Invariant 3

> Server owns authoritative workflow state.

### Invariant 4

> Client owns local execution authority.

### Invariant 5

> Evidence is returned to Server after execution.

### Invariant 6

> Human interaction belongs to the current Step.

### Invariant 7

> WAITING represents an external blocking condition, not workflow pause.

### Invariant 8

> Client-side local intelligence must not silently create a competing global workflow.

---

# 28. Conceptual Summary

```text
                ┌──────────────────────┐
                │   Central Server     │
                │                      │
                │ Planning             │
                │ Context             │
                │ Knowledge            │
                │ Workflow State       │
                └──────────┬───────────┘
                           │
                    One Actionable Step
                           │
                           ▼
                ┌──────────────────────┐
                │      AI Client       │
                │                      │
                │ User Interaction     │
                │ Capability Runtime   │
                │ Local Execution      │
                │ Human-in-the-loop    │
                └──────────┬───────────┘
                           │
                 Local Services / Agents
                           │
                           ▼
                       Evidence
                           │
                           ▼
                    Central Server
                           │
                        Re-plan
```

The fundamental principle is:

> **Server decides what to do next. Client executes what it is currently asked to do. Client reports what actually happened.**
