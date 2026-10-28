# G1 owner-scoped wakeups

Knowing a wakeup id previously let any signed-in person patch or delete it.
Viewers could also create wakeups on a public mind, spending its owner's money.

Create, patch and delete share one stored-mind resolver. Writes require the mind
owner, a hive admin or the hive owner. Unknown, deleted, invisible and nonwritable
targets use the same generic 404. Create and patch reauthenticate through the
existing operator path after reading the body, then recheck current permission.
A body cannot retarget an existing wakeup. Internal scheduling remains trusted.

Text reads are narrower: only the mind owner and admins receive text. Hive
ownership alone grants writes, with `text hidden` in create/patch responses;
it adds no private-mind read visibility. Public/shared viewers retain metadata
with hidden text. Live `wakeup.updated` frames use the same rule. Malformed such
frames are dropped with the constant warning `Dropped malformed wakeup.updated
event`; no payload or token is logged.

Firing keeps the complete scheduled text in the stored message and in delivery
to the mind. Person-facing `/api/agents/{id}/messages` and `message` websocket
frames project `hive:schedule` text by the current mind owner/admin rule, even
if the wakeup row has since been deleted. These privacy-sensitive websocket
frames revalidate their accepted connection bearer, enabled person, current role
and visibility after the queue await. Unrelated event behavior is unchanged.
Live `wakeup.fired` frames are delivered only to current mind owners/admins;
other viewers receive no such frame. This narrows that live notification only.
The existing wakeup metadata API still returns its scheduling timestamps.

The room mirror also retains complete text, now with its `hive:schedule` sender
provenance. A legacy DM can later become a public/shared channel, so its HTTP
history uses the same projection inside `Rooms.messages()`, after room visibility
and canonical row resolution. Both canonical IDs and `c_<mind>` aliases, and
direct callers of that method, receive the same owner/admin text projection.
Earlier mirrors and the existing DM migration
used `system:hive` and lost exact schedule provenance. In a room with a stored
`c_<mind>` alias, a `system:hive` note beginning `[WAKE ` is therefore
conservatively protected too. Ownership comes from that stored mind, never from
client data or the message marker. Only the existing `c_<mind>` mirror alias
identifies a mind; a future mirror in another room must preserve that linkage.
No migration rewrites old text. Room websocket
notices contain room metadata only, not the mirrored message body.

## Shared person-facing host seam

After ordinary message/room visibility filtering, host consumers call:

```python
hive.visibility.project_person_message(current_viewer, message)
```

`current_viewer` must come from current authenticated authority, with the current
admin role, for each request/privacy-sensitive event. This helper does not
authenticate a Viewer or repair a cached websocket identity. Canonical messages
carry their stored `agent_id`. Room consumers additionally pass `agent_id=`
resolved from the stored room alias. The helper masks text only; it does not
replace the caller's existing visibility/filtering rules. Internal persistence,
mind delivery and model inputs stay raw. Existing owner/admin-authorized mind
exports deliberately include complete wakeup text in their manifest; that is an
explicit authority-gated exception, not a viewer read. `Rooms.messages()` now
applies the seam itself, so consumers of that API need no route-level wrapper.
Adapters reading SQL/message_view directly must explicitly use this seam; they
do not inherit HTTP-route protection automatically.

## Principal namespaces

G1 checks any directly matching `people.id` row for every `user:<suffix>`
principal, including legacy family usernames. A disabled row refuses G1 access
independently of token deletion. Missing named `user:u_*` rows fail closed.
The family SSO path can also mint `user:<username>` with no directly matching
people row: that namespace has no separate username disabled flag in the hive;
its allowed-user and expiry rules remain the existing sign-in boundary.

The existing global `role_of` family branch skips the people disabled lookup;
G1 now checks it first, but the global behavior on other routes is a separate
follow-up. Existing family sign-in may use a username instead of
a disabled named email's different person id (the pre-existing SSO regression
records this). This patch does not invent an alias mapping or rewrite sign-in.

## Tests and limits

`hive/tests/test_g1_owner_wakeups.py` covers public/shared fire-time HTTP and websocket projections
for owners/admins versus hive owners/viewers, complete internal delivery, deleted
wakeup history, live authentication/role/ownership changes, converted legacy room
history with old/new provenance, real family SSO session issuance with a disabled
direct person row, response masking, and constant-only malformed-event logging.
The room matrix covers canonical IDs, `c_<mind>` aliases and direct `Rooms.messages()` calls. Fire-time matrices assert owner/admin receipt and other-viewer suppression of `wakeup.fired`, including current authentication, role and ownership changes. All data is synthetic.

This change adds no cross-thread database transaction revocation boundary, generic
websocket auth rewrite or downstream reply taint tracking.
