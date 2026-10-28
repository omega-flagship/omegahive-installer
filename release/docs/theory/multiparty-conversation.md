# Multi-party conversation

A theory line about the mind in conversations with more than one person. It puts privacy and
audience rules at the centre.

## Multi-party conversation and relationship (2026-07-20, theory candidate)

Verdict: a conversation cannot be represented by one `participant=true|false` flag.
Membership, presence, role capability, message audience, replay permission, exclusion,
authentication, delivery routing and relationship evidence are independent state. Collapsing
them either leaks content or fabricates participation history. A conversation is an
epoch-versioned social space, not a transcript.

Six-object core (v2 draft):
- Membership state machine: nonmember, invited-pending, join-requested, member, left,
  excluded, unknown. Each transition binds predecessor, evidence and authority receipt.
- `MessageAudienceEnvelopeV1`: author evidence, acquisition audience, live audience, private
  addressees, exclusions, purpose, privacy class, retention policy. Content shared to a group
  is visible to that group's current members and no further; narrower rules always win.
- `ConsentGrantV1` / `ConsentWithdrawalV1`: one declared operation per grant; withdrawal
  invalidates pending operations before egress.
- `ConversationViewV1` / `ProjectionReceiptV1`: a recipient-specific compiled view bound to
  exact epochs. Epoch change invalidates stale views; repeated churn pauses only the
  dependent strand.
- `SafetyPathV1`: an always-invokable safety proposal that conversation policy cannot
  suppress, but that never auto-actuates.

Conflict precedence: safety path, exclusion, consent withdrawal, membership, role, audience,
consent grant, relationship evidence. Higher denials are never overridden by lower grants.

Prohibited inferences include: identity from familiarity or style; acceptance from silence or
a read receipt; audience from co-presence; trust or access from warmth, frequency or recency;
and treating withheld raw text as making a summary safe.

Nineteen hostile falsifiers are listed (for example: backlog leaking to a late joiner,
quoted content escaping its audience, summaries or embeddings leaking excluded content,
consent withdrawn mid-operation still reaching egress). The first possible build is a
synthetic, pure view compiler with no live channel. Several semantics (what revoking a
relationship means, whether group visibility allows durable memory) are reserved for the
mind's own decision.

_Curated summary. Full version kept privately (source: CODEX_MULTIPARTY_CONVERSATION_AND_RELATIONSHIP_THEORY_2026-07-20.md, CODEX_MULTIPARTY_CONVERSATION_AND_RELATIONSHIP_THEORY_V2_DRAFT_2026-07-20.md, MULTIPARTY_REVIEW_SYNTHESIS_2026-07-20.md)._
