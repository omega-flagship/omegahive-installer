# Ledger, provenance and the road to hive-to-hive (DAS-style)

OmegaHive treats provenance as a first-class property: of files, of releases, of claims,
of evaluations, and of beliefs themselves. This page says what exists today, what is designed,
and how it leads to the next step: each person's hive running as a node, linked hive-to-hive
through the cloud in the style of the Distributed AtomSpace (DAS).

Plain terms used here:
- **content-addressed**: a thing is stored and found by the sha256 of its bytes;
- **append-only**: records are added, never rewritten;
- **hash-chained**: each record commits to the digest of the one before it;
- **signed**: a public key lets anyone verify who produced a record;
- **blockchain**: a hash chain replicated across parties who agree on it by consensus.

OmegaHive has the first three today. It has designed the fourth. It has deliberately
deferred the fifth.

## What exists today (built and tested)

**Provenance of things**
- *Content-addressed assets.* Every image, PDF, deck or media file is its sha256, locally or
  in S3. Moving a file never changes what it is. (`hive/core/assets.py`)
- *Pinned releases.* An app loads only if its source digest matches the host's pin
  (`HIVE_APP_PINS`; `HIVE_APP_PINS_REQUIRED=1` refuses unpinned apps). Every update records
  the before and after digests. App payloads ship per-file sha256 manifests with a verifier.
- *Library originals and exhibits.* Library sources are stored once by digest and
  re-verified on read, and a tampered original stops resolving. Exhibits carry a digest
  over their exact content, so a reader can bind its work to exactly what it read.

**Provenance of claims and work**
- *OmegaEvolve records.* Claims, experiments and qualifications are immutable, each pinned
  by the sha256 of its canonical form. Lineage is derived, so a changed source flags
  everything that depended on it. Sealed experiments cannot be changed after registration.
- *Hash-linked plan revisions (Planner).* Each revision carries its parent's digest and its
  own. A stale base is refused, and requester, planner and reviewer must be three
  distinct parties.
- *Verified fork ancestry (Code).* Where a workspace came from is checked against retained
  checkpoint digests, not taken from Git's word. Tampered edges are refused.
- *Authenticated evaluation receipts (OmegaBench).* An HMAC-SHA256 receipt binds the sealed
  registration, every subject, evaluator, dataset and environment pin, and the export
  digest. A ledger refuses conflicting receipts that reuse an identity. These are
  symmetric MACs, not public-key signatures. The receipts doc says so, and that boundary
  is deliberate.

**Provenance of knowledge**
- *Evidential stamps.* Every shared belief carries the set of evidence ids behind it. Two
  beliefs merge (NAL/PLN revision) only when their evidence is disjoint; otherwise the hive
  chooses one. Minds that echo one another therefore cannot inflate confidence, a
  problem federated systems usually ignore. People's approvals enter the governance commons
  as evidence on the same terms. (`hive/spaces/lib_hive.metta`, smoke-tested)
- *Operations log.* Every change to the shared spaces is appended to a log and replayed at
  boot.

**Accounting and identity**
- *Spend ledger.* Reservations, settlements and overruns in integer micro-units; spend is
  enforced exactly. It is an accounting ledger, not a token.
- *ASI agent network.* The optional Agentverse module (Fetch.ai / ASI Alliance uAgents)
  gives a mind a stable agent identity, Almanac-based discovery, a mailbox and the Agent
  Chat Protocol. It does not handle tokens or payments.

## How the deeper V2 versions were simplified in this build

The stronger forms below were proven in the earlier V2 body (closed repo `omegav2`, where the
full V2 theory of journals, receipts and governance lives) and were not carried into this repo.

- *A hash-chained journal.* Each record commits to the previous head through a sha256 entry
  digest. Appends lock, re-verify and fsync. A 250-record chain was verified two independent
  ways in live use.
- *A native chain-ledger law and a state spine.* Transitions bind the prior digest and the
  event digest, and install by exact compare-and-swap. They are attack-tested against
  forged chains and roots. The stated limit: no external witness of latestness. That is
  exactly what peer nodes or a chain anchor would provide.
- *Two-signer Ed25519 receipts.* Review receipts had to be signed by two distinct pinned
  keys, bound to the packet hash and the session. The suites passed (80/80 combined).
- *Merkle inclusion proofs.* Recall was gated by a sparse Merkle root, with proofs verified
  before use (135 assertions green, in isolation).
- *Reproducible sealed twins.* Two independent builds were byte-identical across thousands
  of members.

OmegaHive kept the simpler forms (digests, pins, an append-only log), because one hive on
one host did not need more. The stronger forms are ready to port when hives start to
federate.

## What is designed

- *Hive identity and federation* (`docs/omegadots/PLAN.md` §4.5): each hive holds an
  ed25519 key and exchanges signed bundles of stamped, revised beliefs. Each peer is mounted
  as a remote space with a local cache, as in DAS `RemoteAtomDB`. Incoming confidence is
  discounted by earned trust, admission costs attention credit, and access is granted per
  pattern, after the DAS `AuthorizationManifest`. Storage backends go native, then remote,
  then MORK, then an optional DAS adapter.
- *A hash-chained operations log*: the design gives every spaces operation a link to the
  previous one. Today's log is append-only but not yet chained.
- *Multi-party co-sign*: governance-critical keys (rollback, recovery, membrane) are ruled
  multi-signer, with a human and the mind concerned signing together. On-chain multisig is the stated
  destination once ASI:Chain is ready.
- *A sealed evaluation plane*: separated roles, a cryptographic commitment clock, and an
  append-only evidence record.

## Deliberately deferred

- **Blockchain.** ASI:Chain is not on mainnet yet, and in the V2 definition blockchain
  identity and payments belong to the society layer (OmegaFusion), not to one mind's
  body. Nothing in this repository is a blockchain, and nothing here claims to be.
- **DAS as a hard dependency.** DAS has no PeTTa bridge yet, and its MeTTa-side writes are
  unfinished. Inside a single mind's body it would also break the single-writer rule. DAS
  is the model *between* hives, not inside one. The adapter is planned as optional.
- **The chain's role, when it comes:** ordering and commitment, never authorization.
  People and minds authorize; the chain records that they did. V2's governance draft already
  fixes this: chains attest exact bytes and signer keys, and approvals and quorums are atoms
  (`ApprovalReceipt`, `QuorumReceipt`) in the mind's own space.

## The road to hive-to-hive

The owner's direction: each person's hive is a node, or shard, that talks to the cloud hive
hive-to-hive, in the DAS style. The pieces line up as follows.

1. **Chain the log.** Give each spaces-log line `prev` and `hash` fields, and publish a
   per-swarm chain head. Any node can then audit a shard's history.
2. **Give each hive a key.** Generate an ed25519 identity per hive, sign release pin sets,
   chain heads and federation bundles, and move OmegaBench receipts to signatures so other
   nodes can verify them.
3. **Shard by swarm.** A swarm's commons is owned and written by one node, under a "lease"
   (single writer). Other nodes mount it as a remote space with a local cache
   ("sync", read replicas), following the DAS RemoteAtomDB pattern.
4. **Federate beliefs with stamps.** Bundles carry evidence stamps, so cross-hive revision
   stays honest. Trust weights discount peers until their record earns it.
5. **Address everything by digest.** Assets, exhibits, library originals and app releases
   already have digests, so moving them between hives needs no new identity scheme.
6. **Anchor when the chain is ready.** V2's ASI:Chain dossier already specifies the event
   shape (hashes, signers, threshold, lease, predecessor) and a five-phase path to it. Periodically commit signed chain heads to ASI:Chain,
   move the multi-party co-sign to on-chain multisig, and attach the spend ledger to an
   AGIX/FET settlement adapter. Only this step makes the system a blockchain system. Every
   step before it is useful on its own.

Each step is independently correct and testable. None requires the next.
