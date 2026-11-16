# Singnet integration boundary (V8)

Inspected `singnet/Omega` HEAD `b94f7bf44e10852e491967191f1c68643dc9ca90`.
It has heartbeat listeners and prompt extensions. Those do not cover Hive's
quiet boot, context after input receipt, command authorization, response
accounting, end-of-cycle persistence and mutable wake settings. Its provider
registry and selected provider remain private. V8 retains the previously tested
pin `a6bd77859fa326b43bf924e6b65d327d17204376` rather than silently upgrading it.

The loop is still generated from that upstream pin with checked substitutions.
It is not an unpatched upstream integration. No second scheduler or vendored
fallback has been added. The upstream checkout itself remains clean. The narrow
adapter and its exact-match checks remain until upstream exposes sufficient APIs.

Proposed upstream public contract:

- Lifecycle callbacks: boot, context after receive, before command execution,
  after response, end of cycle. A callback failure must not execute a command.
- Public configuration override and provider lookup/selection calls, plus a
  provider decoration hook; these replace private registry/config access.
- Explicit response error categories: transport, authentication, rate limit,
  format, and incomplete output. Preserve error type through the provider API.
- Configuration logs should record source and key, never resolved values.
  Redacting only names containing `key` is insufficient for arbitrary settings.

No upstream PR or push has been made. V8 protects config logging locally using
a record filter installed before config initialization. This also suppresses
exception payloads. The upstream logger itself is still vulnerable without that
Hive protection, so the upstream change is worthwhile.

Unlisted skills now default to `ask`; explicit policy rules and the existing
reviewed defaults still apply. Existing repository reads and budget-guarded
image-generation skills are listed explicitly; their existing access and cost
checks remain in force. Native tool responses enter only Hive's single
transport tool, then its parser and per-command policy. V7 and V8 have one
`add-skill` implementation, supplied by upstream; the regression test guards it.

Malformed tool calls and incomplete replies execute no commands and schedule
a two-second retry. Transport/provider errors retain sixty-second backoff.
There is no live external-model validation claim for this release.
