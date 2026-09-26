# SERVER_SPEC.md

# Central AI Orchestrator Specification

**Version:** 0.2
**Status:** Draft
**Role:** AI Brain + Context Engine + Knowledge Engine + Workflow Orchestrator

---

# 1. Overview

The Central Server is the authoritative orchestration layer of the system.

Its primary responsibilities are:

1. receiving user goals;
2. maintaining workflow state;
3. composing context;
4. retrieving knowledge;
5. understanding available Client capabilities;
6. invoking LLMs;
7. planning the next actionable Step;
8. dispatching that Step to a Client;
9. receiving execution results and Evidence;
10. updating context;
11. re-planning based on actual observations.

The Server does **not** directly execute local operations.

The Client is the execution endpoint.

The fundamental loop is:

```text
User Goal
   ↓
Context Assembly
   ↓
LLM Planning
   ↓
One Step
   ↓
Client Execution
   ↓
Evidence
   ↓
Context Update
   ↓
LLM Re-planning
   ↓
One Step
```

---

# 2. Core Architecture

```text
┌─────────────────────────────────────────────────────┐
│                  Central Server                     │
│                                                     │
│  ┌──────────────┐     ┌──────────────────────────┐  │
│  │ Session      │     │ Workflow Engine          │  │
│  │ Manager      │     │                          │  │
│  └──────┬───────┘     └────────────┬─────────────┘  │
│         │                          │                │
│         ▼                          ▼                │
│  ┌──────────────────────────────────────────────┐  │
│  │              Context Engine                  │  │
│  │                                              │  │
│  │ Conversation / Workspace / Evidence / State  │  │
│  └──────────────────────┬───────────────────────┘  │
│                         │                          │
│              ┌──────────┴──────────┐               │
│              ▼                     ▼               │
│      Knowledge Engine        Capability Registry   │
│              │                     │               │
│              └──────────┬──────────┘               │
│                         ▼                          │
│                  Planning Engine                   │
│                         │                          │
│                         ▼                          │
│                    LLM Gateway                     │
│                         │                          │
│                         ▼                          │
│                 One Actionable Step                │
└─────────────────────────┬───────────────────────────┘
                          │
                          ▼
                     AI Client
                          │
                 Local Execution
                          │
                          ▼
                       Evidence
                          │
                          └──────────────► Server
```

---

# 3. Design Principles

## 3.1 Centralized Planning

The Server is the primary planning authority.

The Server determines:

* what should happen next;
* which capability should be used;
* what inputs are required;
* what Evidence should be collected;
* whether additional user interaction is required.

---

## 3.2 Single-Step Planning

The Server MUST plan and dispatch only one actionable Step at a time.

The Server MUST NOT normally send:

```text
Step 1
Step 2
Step 3
Step 4
```

as a pre-generated execution plan to the Client.

Instead:

```text
Plan Step 1
   ↓
Execute Step 1
   ↓
Observe
   ↓
Re-plan
   ↓
Plan Step 2
```

This is a fundamental architectural constraint.

---

# 4. Why Single-Step Dispatch

Single-Step dispatch provides several important properties.

## 4.1 Fresh Evidence

Every new Step is planned using the latest execution Evidence.

## 4.2 Reduced Stale Planning

A plan generated before execution may become invalid after new information appears.

Single-Step dispatch minimizes this problem.

## 4.3 Capability Awareness

The Server can re-evaluate available Client capabilities before each Step.

## 4.4 Dynamic Re-planning

Execution results can alter the solution path.

For example:

```text
Expected:
    service is running

Actual:
    service is stopped
```

The Server can generate:

```text
Step N+1:
    start service
```

instead of blindly continuing an old plan.

---

# 5. Authority Model

The architecture uses explicit authority boundaries.

```text
LLM
    =
Decision / Planning Authority

Workflow Engine
    =
State Authority

Client
    =
Execution Authority

User
    =
Human Authorization / Information Source
```

The LLM MUST NOT directly mutate authoritative workflow state.

The LLM proposes an action.

The Workflow Engine validates and commits the resulting state transition.

The Client executes the requested operation.

---

# 6. Session Management

A Session represents an interaction between:

```text
User
Client
Server
```

A session MAY contain:

```text
session_id
user_id
client_id
conversation
active_workflows
workspace
capability_context
```

Sessions SHOULD survive temporary Client reconnection.

---

# 7. Workflow

A Workflow represents the problem or objective being solved.

Examples:

```text
Diagnose failing service
Investigate test failure
Modify local project
Collect HIL diagnostic evidence
Configure device
Generate and validate configuration
```

A Workflow contains:

```text
workflow_id
goal
state
current_step
history
context
evidence
client
created_at
updated_at
```

---

# 8. Workflow State Machine

The core Workflow states are:

```text
CREATED
RUNNING
COMPLETED
FAILED
CANCELLED
```

## CREATED

Workflow exists but has not started execution.

## RUNNING

Workflow is actively being solved.

This includes periods where its current Step is:

```text
PENDING
RUNNING
WAITING
```

## COMPLETED

The Server determines that the user's goal has been successfully achieved.

## FAILED

The Server determines that the workflow cannot continue successfully.

A failed Step does not necessarily mean the entire Workflow has failed.

The Server MAY:

* retry;
* generate another Step;
* use another capability;
* request additional information.

## CANCELLED

The Workflow was explicitly terminated.

Cancellation is distinct from failure.

---

# 9. Step

A Step represents the next concrete action to execute.

A Step SHOULD be:

* actionable;
* bounded;
* observable;
* executable by one Client capability;
* associated with clear input and expected output.

Example:

```json
{
  "step_id": "step_004",
  "capability": "git.diff",
  "input": {
    "repository": "/workspace/project"
  }
}
```

---

# 10. Step State Machine

The core Step states are:

```text
PENDING
RUNNING
WAITING
COMPLETED
FAILED
CANCELLED
```

### PENDING

Step exists but execution has not started.

Typical reasons:

* previous Step has not completed;
* execution request has not yet been dispatched;
* prerequisite is not ready.

### RUNNING

Client is actively executing the Step.

### WAITING

Execution cannot continue because an external event is required.

Examples:

```text
user confirmation
user input
device event
external resource
local service response
```

### COMPLETED

The Step completed successfully.

### FAILED

The Step was attempted but failed.

The Server MAY re-plan.

### CANCELLED

The Step was explicitly cancelled.

---

# 11. WAITING Semantics

`WAITING` is a blocking condition, not a workflow lifecycle state.

There is intentionally no core:

```text
PAUSED
RESUMING
```

state.

Example:

```text
Step:
    RUNNING
       ↓
    WAITING
       ↓
external event
       ↓
    RUNNING
       ↓
 COMPLETED
```

The Workflow remains:

```text
RUNNING
```

during this period.

---

# 12. Planning Engine

The Planning Engine determines the next Step.

Its input SHOULD include:

```text
User Goal
Conversation
Workflow State
Current Step
Previous Steps
Execution Results
Evidence
Knowledge
Workspace State
Client Capabilities
User Responses
Constraints
Permissions
```

The planner produces:

```text
next Step
```

not an entire mandatory execution sequence.

---

# 13. LLM Gateway

The LLM Gateway abstracts model execution.

It MAY support:

```text
OpenAI
Anthropic
local models
vLLM
SGLang
other model providers
```

The LLM Gateway is responsible for:

* model selection;
* request construction;
* model invocation;
* response normalization;
* token/usage tracking;
* timeout handling;
* provider failure handling.

The Workflow Engine remains authoritative over state.

---

# 14. Context Engine

The Context Engine constructs the context used for planning.

Potential sources:

```text
conversation
workflow state
current Step
historical Steps
Evidence
knowledge retrieval
workspace
Client capabilities
user input
system policies
permissions
```

The Context Engine SHOULD distinguish:

```text
observed facts
retrieved knowledge
user statements
LLM-generated hypotheses
previous decisions
```

This reduces confusion between Evidence and inference.

---

# 15. Evidence Model

Evidence is a first-class object.

Example:

```json
{
  "evidence_id": "ev_001",
  "workflow_id": "wf_001",
  "step_id": "step_004",
  "source": "client",
  "type": "command_output",
  "timestamp": "2026-09-23T12:00:00Z",
  "data": {}
}
```

Possible sources:

```text
client_tool
device
local_agent
user
server
knowledge_base
external_system
```

The Server SHOULD preserve Evidence provenance.

---

# 16. Evidence vs LLM Reasoning

The system MUST distinguish:

```text
Evidence
    ↓
Observation
    ↓
Interpretation
    ↓
Hypothesis
    ↓
Next Step
```

For example:

```text
Evidence:
    process exited with code 1

Interpretation:
    application failed during startup

Hypothesis:
    configuration may be invalid

Next Step:
    inspect configuration file
```

The hypothesis is not Evidence.

---

# 17. Knowledge Engine

The Knowledge Engine provides relevant knowledge to the Context Engine and Planner.

Possible sources:

```text
documentation
code repositories
manuals
knowledge bases
vector databases
enterprise systems
historical cases
diagnostic databases
```

The Knowledge Engine SHOULD expose retrieval results with provenance.

Example:

```json
{
  "source_id": "doc_123",
  "title": "Device Configuration Manual",
  "content": "...",
  "relevance": 0.91
}
```

Knowledge retrieval is supporting context.

It does not automatically override actual runtime Evidence.

---

# 18. Client Capability Registry

The Server maintains a registry of capabilities exposed by Clients.

Example:

```text
client_001
    git.diff
    git.status
    shell.execute
    filesystem.read

client_002
    device.read
    device.configure
    camera.capture
```

The registry SHOULD track:

```text
client_id
capability_id
version
availability
permissions
metadata
last_seen
```

Capability information MAY become stale.

The Server SHOULD account for this when planning.

---

# 19. Capability-Aware Planning

The Planner MUST consider actual Client capabilities.

Example:

```text
Goal:
    Diagnose camera connection failure

Client capabilities:
    i2c.capture
    oscilloscope.read
    mipi.measure
    filesystem.write

Planner:
    select i2c.capture
```

If the Client reports:

```text
i2c.capture unavailable
```

the Server may select another capability or request user intervention.

---

# 20. Execution Request

The Server sends an execution request containing one Step.

Example:

```json
{
  "type": "execution.request",
  "workflow_id": "wf_001",
  "step_id": "step_005",
  "capability": {
    "id": "git.diff",
    "version": "1.0"
  },
  "input": {
    "repository": "/workspace/project"
  }
}
```

The Client SHOULD validate:

```text
capability exists
input valid
permission available
resource available
```

---

# 21. Execution Result

The Client reports the result of the current Step.

Success:

```json
{
  "type": "execution.completed",
  "workflow_id": "wf_001",
  "step_id": "step_005",
  "result": {},
  "evidence": []
}
```

Failure:

```json
{
  "type": "execution.failed",
  "workflow_id": "wf_001",
  "step_id": "step_005",
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "..."
  }
}
```

The Server then determines what happens next.

---

# 22. Human-in-the-loop

Human interaction is represented as part of the current Step.

The Server may generate a Step that requires user interaction.

Example:

```text
Step:
    Apply configuration to device
```

Client:

```text
execution.started
      ↓
execution.waiting
      ↓
user.input.request
```

User:

```text
confirm
```

Client:

```text
user.response
execution.completed
evidence
```

The Server then re-evaluates the workflow.

---

# 23. User Response

User responses are Evidence / Events that can influence planning.

Example:

```json
{
  "type": "user.response",
  "workflow_id": "wf_001",
  "step_id": "step_006",
  "request_id": "req_123",
  "response": {
    "type": "confirmation",
    "value": "reject"
  }
}
```

The Server MUST NOT assume that:

```text
reject = workflow failed
```

Instead it evaluates the response in context.

---

# 24. Planning Cycle

The Server follows this cycle:

```text
1. Receive goal
       ↓
2. Create Workflow
       ↓
3. Assemble Context
       ↓
4. Retrieve Knowledge
       ↓
5. Inspect Client Capabilities
       ↓
6. Invoke Planner / LLM
       ↓
7. Validate proposed Step
       ↓
8. Dispatch one Step
       ↓
9. Receive execution result
       ↓
10. Store Evidence
       ↓
11. Update Context
       ↓
12. Decide whether goal is complete
       │
       ├── yes → COMPLETED
       │
       └── no
             ↓
          Re-plan
             ↓
        Next Step
```

---

# 25. Step Validation

The Server SHOULD validate an LLM-generated Step before dispatching it.

Validation MAY include:

```text
capability exists
client available
input conforms to schema
permissions allow operation
Step is within workflow scope
required dependencies exist
security policy permits operation
```

The LLM does not have direct execution authority.

---

# 26. LLM Output Contract

The Planner SHOULD produce structured output.

Example:

```json
{
  "decision": "continue",
  "step": {
    "capability": "git.diff",
    "input": {
      "repository": "/workspace/project"
    }
  },
  "reasoning_summary": "Inspect current changes before determining the next modification"
}
```

The production system SHOULD avoid exposing unrestricted chain-of-thought as a protocol requirement.

Only the structured planning result needed by the Workflow Engine should be persisted.

---

# 27. Goal Completion

The Server determines whether the workflow goal has been achieved.

Completion SHOULD be based on:

```text
Evidence
workflow objective
validation results
user requirements
success criteria
```

The LLM MAY propose:

```text
goal_complete = true
```

but the Workflow Engine SHOULD validate the completion condition where possible.

---

# 28. Failure Handling

Failures are categorized.

### Step failure

```text
execution.failed
```

does not automatically imply:

```text
workflow.failed
```

The Server may:

```text
retry
re-plan
choose another capability
request user input
terminate
```

### Workflow failure

Workflow becomes:

```text
FAILED
```

only when the Server determines that the goal cannot be successfully continued.

---

# 29. Retry

Retries SHOULD be controlled by the Workflow Engine.

The Server SHOULD distinguish:

```text
transient failure
permanent failure
unknown failure
```

Example:

```text
network timeout
    ↓
retry

permission denied
    ↓
probably re-plan / request authorization

invalid input
    ↓
correct Step
```

Retries MUST respect idempotency and side-effect constraints.

---

# 30. Cancellation

The Server MAY cancel a workflow.

Example:

```text
workflow.cancel
```

The Client should stop execution where safe.

The Server then transitions the Workflow to:

```text
CANCELLED
```

after the execution state has been reconciled.

---

# 31. No Workflow-Level Pause/Resume

The Server SHOULD NOT model ordinary external waiting as:

```text
PAUSED
RESUMED
```

Instead:

```text
Workflow:
    RUNNING

Current Step:
    WAITING
```

Examples:

```text
WAITING for user
WAITING for device
WAITING for local service
WAITING for external resource
```

This keeps the workflow state model simple.

---

# 32. Event Model

Core Server → Client events:

```text
workflow.start
execution.request
user.input.request
workflow.cancel
```

Core Client → Server events:

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

The protocol should be event-oriented even when transported through REST.

---

# 33. Event Ordering

Events SHOULD contain:

```text
event_id
timestamp
workflow_id
step_id
request_id
sequence
```

The Server SHOULD detect:

```text
duplicate events
out-of-order events
missing events
stale events
```

The Workflow Engine remains the authority for accepting valid state transitions.

---

# 34. Idempotency

Every execution request SHOULD have a unique execution identifier.

Example:

```text
execution_id = exec_123
```

The Server SHOULD avoid dispatching the same side-effecting operation multiple times unless explicitly intended.

The Client SHOULD also protect against duplicate execution.

---

# 35. Multi-Client Support

A Workflow MAY interact with multiple Clients.

Example:

```text
Client A:
    developer workstation

Client B:
    HIL test bench

Client C:
    diagnostic device
```

The Server maintains the global workflow.

A Step is dispatched to the Client that can execute it.

Example:

```text
Step 1 → Client A
Step 2 → Client B
Step 3 → Client C
Step 4 → Client A
```

The same Workflow may therefore coordinate multiple execution environments.

---

# 36. Multi-Agent Support

Agents MAY exist on:

```text
Server
Client
external systems
```

The Server remains responsible for global orchestration.

A local Agent is treated as an execution capability.

A Server-side Agent may assist with:

```text
planning
knowledge retrieval
analysis
specialized reasoning
```

Multiple agents MUST NOT create conflicting authoritative workflow states.

---

# 37. Security and Authorization

The Server is responsible for global authorization policies.

The Client is responsible for local enforcement.

Therefore:

```text
Server:
    Is this operation allowed within this workflow?

Client:
    Can this local environment execute it safely?
```

Both checks SHOULD be enforced.

High-risk operations SHOULD support explicit user confirmation.

---

# 38. Audit

The Server SHOULD maintain an audit trail containing:

```text
workflow
Step
planning decision
capability selected
execution request
execution result
Evidence
user response
state transition
```

This enables:

* debugging;
* reproducibility;
* compliance;
* diagnosis;
* workflow replay;
* system improvement.

---

# 39. Observability

The Server SHOULD expose:

```text
workflow metrics
step latency
LLM latency
token usage
execution latency
failure rate
retry rate
capability availability
waiting duration
Evidence volume
```

Tracing SHOULD use correlation IDs:

```text
workflow_id
step_id
execution_id
request_id
event_id
```

---

# 40. Persistence

The Server SHOULD persist at least:

```text
Users
Sessions
Workflows
Steps
Events
Evidence metadata
Capability registry
Audit records
Knowledge references
```

Large Evidence objects MAY be stored in object storage rather than the primary database.

---

# 41. Data Model

A simplified model:

```text
User
 │
 └── Session
       │
       └── Workflow
             │
             ├── Context
             ├── Step
             │    ├── Execution
             │    └── Evidence
             │
             ├── History
             └── State
```

---

# 42. Example End-to-End Flow

User:

```text
"Find out why the local service is failing."
```

Server:

```text
Create Workflow
```

Client capabilities:

```text
process.list
service.status
service.logs
filesystem.read
shell.execute
```

Planner creates:

```text
Step 1:
    service.status
```

Client executes.

Result:

```text
service = stopped
```

Evidence:

```text
service is not running
```

Server re-plans.

```text
Step 2:
    service.logs
```

Client executes.

Evidence:

```text
configuration file not found
```

Server re-plans.

```text
Step 3:
    filesystem.read
```

Evidence:

```text
configuration file exists at another location
```

Server re-plans.

```text
Step 4:
    service.configure
```

Client requires user confirmation.

```text
WAITING
```

User confirms.

Client executes.

Evidence:

```text
service started successfully
```

Server validates the goal.

```text
Workflow → COMPLETED
```

At no point did the Server send:

```text
Step 1
Step 2
Step 3
Step 4
```

in advance.

Every Step was generated from the latest available Evidence.

---

# 43. Non-Goals

The Server is not intended to:

* directly execute arbitrary Client operations;
* embed all local tools;
* replace local execution environments;
* require Clients to run autonomous LLMs;
* pre-generate immutable multi-step execution plans;
* treat LLM output as authoritative workflow state.

---

# 44. MVP

The MVP Server SHOULD contain:

### Core

* authentication;
* sessions;
* workflows;
* workflow state machine;
* Step state machine;
* event system;
* persistence.

### AI

* LLM Gateway;
* Planner;
* Context Engine;
* basic Knowledge/RAG integration.

### Client Integration

* capability registry;
* capability manifest;
* execution request;
* execution result;
* Evidence ingestion.

### Human-in-the-loop

* user input request;
* user response;
* WAITING handling.

### Reliability

* correlation IDs;
* idempotency;
* retry;
* reconnect;
* timeout handling.

---

# 45. Core Invariants

### Invariant 1

> Server is the authoritative Workflow State Authority.

### Invariant 2

> Server dispatches only one actionable Step to a Client at a time.

### Invariant 3

> LLM proposes decisions; Workflow Engine validates and commits state transitions.

### Invariant 4

> Client executes; Server does not assume execution succeeded until Evidence is received.

### Invariant 5

> Every new Step SHOULD be planned using the latest available Evidence.

### Invariant 6

> WAITING is a Step blocking condition, not a Workflow pause state.

### Invariant 7

> A failed Step does not automatically imply a failed Workflow.

### Invariant 8

> User responses become inputs to the orchestration loop.

### Invariant 9

> Client capabilities are inputs to planning, not guarantees of availability.

### Invariant 10

> Evidence has higher authority than an unsupported LLM assumption about the local environment.

---

# 46. Conceptual Summary

The Central Server is essentially:

```text
            ┌────────────────────────────┐
            │      Central Server        │
            │                            │
            │  Goal                      │
            │    ↓                       │
            │  Context                   │
            │    ↓                       │
            │  Knowledge                 │
            │    ↓                       │
            │  Client Capabilities       │
            │    ↓                       │
            │  LLM / Planner             │
            │    ↓                       │
            │  One Step                  │
            │    ↓                       │
            │  Workflow Engine           │
            └────────────┬───────────────┘
                         │
                    Execute One Step
                         │
                         ▼
                    AI Client
                         │
                  Local Execution
                         │
                         ▼
                      Evidence
                         │
                         ▼
            ┌────────────────────────────┐
            │      Context Update        │
            └────────────┬───────────────┘
                         │
                       Re-plan
                         │
                         ▼
                     Next Step
```

The fundamental principle is:

> **Server never tells Client how to solve the whole problem. Server tells Client only what to do next. Client executes it and reports what actually happened.**
