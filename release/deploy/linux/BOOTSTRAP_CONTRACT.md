# Local first-install bootstrap

This self-contained module imports no Hive code. It uses the pinned L0 control
module, one-use local sign-in and normal authenticated owner APIs. The installer
calls `bootstrap.py --runtime <fixed home runtime.json> --seed <pinned seed>`
with the selected private Python loader environment. The public seed is included
verbatim; its exact hash is required, including the reviewed model, budget,
role prompt and deny rules. No template settings are guessed.

The service's canonical executable, user-manager MainPID and same-UID control
socket are checked by the control module. Before sending a code or bearer over
loopback HTTP, bootstrap also joins that exact established connection's numeric
IPv4 tuple/inode/UID to the selected MainPID's socket FD metadata. It reads no FD
bodies, environment, account file or database. The bounded kernel tables and
socket-link names remain in memory. There is no alternate host, proxy, redirect,
cookie import or generic HTTP dispatcher. JSON/status/length limits and absolute
socket deadlines fail closed. This Linux metadata protocol still needs actual
fresh-VM coverage.

The exchanged bearer must identify the exact named local owner as a signed-in
admin. Password/operator and setup-purpose bearers are refused. The helper
inspects the loaded app digests, performs the canonical named-admin install
review for the two pinned bundled apps, and reads back the review. It supplies
no per-person allowlist, activation, Ask grant or person-swarm consent.

Role and template creation use `/api/roles` and `/api/agents`. A matching existing
seed is reused; a conflicting name, owner, budget, key, role, or awake/spending
template is refused. An uncertain POST is not retried automatically. A later
explicit invocation reconciles exact content through the same owner API. The
new template is never started: it is created stopped, explicitly slept and read
back asleep/disconnected with zero spend. Its returned agent credential is
discarded in memory. The helper does not guarantee that a later authorized admin
can never wake or edit that template.

Logout is attempted in cleanup, including cancellation; failed logout prevents a
success result. Code, bearer, returned agent token, cookie and raw HTTP bodies
are never written to stdout, logs, argv, state or receipts. Python memory is not
claimed to provide secure zeroization. The normal owner-authenticated backend
stores only what its normal routes already store.

After logout, the unchanged descriptor is atomically replaced with the returned
template ID under an exclusive bootstrap lock. All other settings are retained.
One fixed `systemctl --user restart omegahive.service` follows. The helper waits
up to 180 seconds for a new local instance through the same validated hello path,
then checks its listener and rereads the descriptor. The initial readiness wait
has the same bound; the installer permits 480 seconds for the complete helper. Failed/partial setup is not
reported as ready; there is no automatic reconnect/restart loop or rollback of
unrelated owner state. No model/provider request or user consent is generated.

Before enabling a release, the release builder must reconcile the normal API
seams against the selected scrubbed GitHub release tree. Earlier private deployed
source is retained only as implementation context.
Own synthetic unit tests and the actual bootstrap/install/browser flow remain
NOT_RUN. A successful bootstrap would establish only these setup acts, not a
real-provider conversation, whole-suite pass or deployment acceptance.

# Private GitHub release download

The release remains private. A browser's GitHub sign-in does not become curl
authentication. GitHub's release-asset API requires repository read authority for
private resources; unauthenticated access is described for public resources.
See [GitHub's release-assets documentation](https://docs.github.com/en/rest/releases/assets).

Proposed packaging: while signed in, the user downloads one kit from the private
pre-release page. That kit embeds the exact scrubbed release tarball, app assets
and their checksums, unchanged from the separately published assets. The script
verifies those local bytes; only public checksum-pinned runtime artifacts are
downloaded during installation. Until publication, test the identical local kit.
Record the release branch/tag and asset URLs as provenance, without assuming an
unauthenticated curl can retrieve them. This packaging choice must be confirmed
by the release owner; it does not silently change the required release tree.

Do not embed a personal token, copy browser cookies, scrape a logged-in browser,
print a signed asset URL, or invent a new authentication flow. Publication is
PR-only on the owner's scrubbed release branch, with invented examples and no
personal names or internal paths in the shipped module. No publication occurred
while preparing this Source.
