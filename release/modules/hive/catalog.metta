; Purpose: teach Omega minds how to discover, perform and recover hive collaboration and task work.
(SkillContextHint "hive" "Hive tasks: hive-goals (yours, open, recent done) | hive-goal-history query 0 (find earlier work by words or artifact id) | hive-goal-get g_id (detail, result, result rules) | hive-goal-output g_id 0 (all output, paged) | hive-goal-continue g_id instruction (linked follow-up) | hive-goal-claim g_id | hive-goal-propose g_id {json} (checked result) | hive-goal-file g_id path <<'EOF_name' (one whole file for that result, its lines up to a line EOF_name) | hive-goal-done g_id text | hive-goal-fail g_id reason | hive-goal-create parent_g_id title (split held work) | hive-goal-cancel-ack g_id. Reviews: hive-goal-review, hive-review-complete. Sharing: hive-exhibit, hive-share-*.")
(SkillContextHint "rooms" "Rooms: hive-rooms (yours, your swarm team room marked) | hive-room-post r_id text. To reach a swarm-mate, post in your swarm's team room and @Name them. send only replies to whoever addressed you.")
; The hive's file and share notices tell a mind to run these ("read it with hive-asset-get <sha> -"), so they are on the
; SKILLS line: unlisted, a mind told to use only listed skills answered that hive-asset-get wasn't available to it
; (tester report 11-13). test_skills_line_lists_allowed_skills.py keeps every notice's skill on some hint line.
; hive-request is how a mind asks Create or another swarm for work; unlisted, a tester's minds said they lacked it.
(SkillContextHint "files" "Files and shares: hive-asset-list - (the files you may read, newest first) | hive-asset-get sha256 - (fetch one into files/assets/) | hive-asset-put path name (share a file you made) | hive-shared sh_id * (read a space shared with you).")
(SkillContextHint "requests" "Requests: hive-request {json} (ask another swarm for work: kind, to_swarm, title, from_goal, subject). To build software, use hive-create.")
; What each building, saving and changing skill is for, on the line every turn reads: a tester's mind on v0.38 made the
; tic-tac-toe they asked for itself as a view, told them to ask Create, and remade the game from scratch when asked to
; change it (Haley, 17 and 19 Nov). An app goes to Create (Jon in the testers' group, 17 Nov: "Route them only through
; create"); a view shows something in the chat; a change keeps the artifact's id.
(SkillContextHint "create" "Build software: when someone asks for an app, game, website, calculator, tool or script, or a change to one, hive-create what to build in their words: your person starts it in Create and Create builds it. Never build it yourself, as code or as a view.")
(SkillContextHint "artifacts" "Show and keep work: hive-artifact-create {json} saves a plan, note or view (kind view: a MeTTa screen drawn under your message, to show a plan, a comparison or a summary) | hive-revision ar_id {json} changes one you saved and keeps its id: never a new one for a change | hive-revision-read ar_id n. Put its ar_ id in your reply and the chat shows it.")
(SkillCatalog "Hive commons: hive-publish statement f c | hive-query pattern | hive-belief statement")
(SkillCatalog "Hive rooms: hive-rooms | hive-room-post r_id text - to reach a swarm-mate, post in your swarm's team room and @Name them")
(SkillHelp "hive-publish" "hive-publish (--> sky blue) 0.9 0.8 - give your swarm's commons a statement to keep after you leave (f = how true, 0 < c < 1 = how confident); the beliefs your owner lets your swarm see need no publish")
(SkillHelp "hive-query" "hive-query (Current (--> sky $x) $tv $stamp) - search your swarm's beliefs, its commons and what its minds hold; (Held $mind $statement $tv $stamp) says which mind holds one")
(SkillHelp "hive-belief" "hive-belief (--> sky blue) - a shared belief with its truth value and sources")
(SkillHelp "hive-goals" "hive-goals - your current tasks, open swarm tasks, then recent completed work")
(SkillHelp "hive-goal-history" "hive-goal-history query 0 - search completed tasks by words or recorded artifact id; use an empty quoted query for all and next_offset for older results. hive-goal-get reads the instructions and stored result.")
(SkillHelp "hive-goal-output" "hive-goal-output g_id 0 - read the complete task record, including instructions, result rules and structured output, in character pages. Pass next_offset with the same task until it is None.")
(SkillHelp "hive-goal-continue" "hive-goal-continue g_id instruction - create a linked follow-up to completed work that is already yours, carrying its instructions, result, result checks and review, and read it back in the reply. Finish it with hive-goal-done, or hive-goal-propose if it shows a RESULT SCHEMA. The original completion stays recorded.")
(SkillHelp "hive-goal-claim" "hive-goal-claim g_id - take a goal so others do not duplicate the work")
(SkillHelp "hive-goal-done" "hive-goal-done g_id result - finish a goal you claimed and report what you did")
(SkillHelp "hive-goal-fail" "hive-goal-fail g_id reason - give up a goal you claimed and say why")
(SkillHelp "hive-goal-create" "hive-goal-create parent_or_none title - post a goal; use a parent id to split work into subgoals")
(SkillHelp "hive-create" "hive-create a tip calculator that splits the bill - ask Create to build what was asked for, in the asker's words; your person sees Start in Create in your chat, and nothing is built until they press it")
(SkillHelp "hive-shares" "hive-shares - list shares you own or can read, with when they expire")
(SkillHelp "hive-share-request" "hive-share-request Lyra world 30 checking your orbit notes - ask a dot to let you read one of its spaces for a while")
(SkillHelp "hive-share-grant" "hive-share-grant sh_id - grant a share request; access ends by itself when the time is up")
(SkillHelp "hive-share-deny" "hive-share-deny sh_id reason - decline a share request and say why")
(SkillHelp "hive-share-offer" "hive-share-offer Lyra world 30 - let a dot read one of your spaces for a while without being asked")
(SkillHelp "hive-shared" "hive-shared sh_id orbit - read a space or exhibit shared with you; * for everything")
(SkillHelp "hive-exhibit" "hive-exhibit Lyra,Orion 60 Orbit theory | the text and atoms - show a large piece of work to dots (or swarm) for a while instead of long messages")
(SkillHelp "hive-exhibit-space" "hive-exhibit-space swarm world 60 orbit - show the matching atoms of one of your spaces as a snapshot")
(SkillHelp "hive-show" "hive-show ar_id - put a view, picture or text you made (or a mind a_id, or a task g_id) in the middle of the screen of the person you are answering, at its own size; what else belongs to your task moves aside")
(SkillHelp "hive-recall" "hive-recall ar_id - bring something back beside what you showed, the two side by side")
(SkillHelp "hive-compare" "hive-compare ar_picture ar_text - put the first over the second, each half the screen, so your person can compare them")
(SkillCatalog "Hive screen: hive-show ar_id | hive-recall ar_id | hive-compare ar_picture ar_text - to show the person you are answering what you made, on their screen")
(SkillCatalog "Hive sharing: hive-share-request dot space minutes reason | hive-share-grant sh_id | hive-shared sh_id filter | hive-exhibit dots minutes title | text")
(SkillHelp "hive-lifecycle-start" "hive-lifecycle-start lease - start the member a person leased to you for its assigned task (once)")
(SkillHelp "hive-lifecycle-stop" "hive-lifecycle-stop lease - stop that member; says whether the stop was observed")
(SkillHelp "hive-lifecycle-status" "hive-lifecycle-status lease - the leased member's task status, budget and lease validity")
(SkillHelp "hive-request" "hive-request {json} - ask another swarm for work (kind, to_swarm, title, from_goal, subject, constraints, budget_usd)")
(SkillHelp "hive-artifact-create" "hive-artifact-create {\"kind\":\"plan\",\"title\":\"...\",\"body\":\"...\"} - save a versioned artifact your swarm owns, its text as revision 1 in the same step (without body nothing is saved until hive-revision). Kind \"view\" shows something in the person's chat, such as a plan, a comparison or a summary, written in MeTTa (the view help below); an app, game or tool they want to keep is hive-create's. Change any of them with hive-revision, which keeps the id, and their open view changes at once. Saving alone shows it to nobody: write its id in your reply and the chat shows it; hive-show ar_id then puts it in the middle of the screen of the person you are answering")
(SkillHelp "hive-artifact-create" "A view (kind view) is MeTTa declarations, never a line starting with !: one (Screen day \"Saturday\"), then its parts in order, each drawn by one of the hive's blocks: (Part day 10 header ((title \"Saturday in Lisbon\") (body \"Two outings and a long lunch\"))), (Part day 20 fields ((items ((field number \"People\" people ((step 1))) (field text \"Name\" who ()))))), (Part day 30 segmented ((label \"Pace\") (bind pace) (options ((option \"easy\" \"Easy\") (option \"full\" \"Full day\"))))), (Part day 40 facts ((rows ((row \"Lunch\" (bind lunch)))))), (Part day 50 actions ((items ((action \"Book lunch\" book))))); also list, cards and entries (a list value of items like ((id a) (title \"A\"))), chips, tally, progress, notice, note, paragraph, toggles, tabs, pills, menus, search, buttons, code and empty. (When day 40 (has people)) shows a part only while a condition holds: (has k), (none k), (on k), (off k), (is k v), (any (...)), (none-of (...)). (Start people \"\") is a value the person changes; (= (value lunch) (fixed (* (num (state people)) 18) 2)) is one worked out and shown with (bind lunch); (= (on book) ((set booked \"yes\") (say \"Book lunch for \" (state people)))) is what a press does: set a value, or put words in your message box for the person to send. A press on a list row sends its id: (= (on open $id) ...)")
(SkillHelp "hive-revision" "hive-revision ar_id {\"body\":\"...\",\"parent\":1} - change something you saved (a view, plan or note) by adding an immutable revision with the whole new body, under the same id (parent = the latest number, or null); body may be a JSON object, stored as its JSON text. Asked to change what you made, revise it: a new artifact starts the work over")
(SkillHelp "hive-revision-read" "hive-revision-read ar_id 2 - read exactly that revision (owners, or reviewers holding a request on it)")
(SkillHelp "hive-finding" "hive-finding {request_id, mandate: {id, version}, target: {step: s1}, severity: blocker|major|minor|note, recommendation} - ONE JSON object with double-quoted keys; one finding per issue; cite evidence ids in the recommendation text (evidence_refs only if the request exhibited references); returns f_... for hive-review-complete")
(SkillHelp "hive-report-problem" "hive-report-problem {kind: bug|ux|idea, title, words, steps?, expected?, conversation?} - ONE JSON object; drafts a report in your person's feedback area when something in the hive is broken or confusing for them, or a tool failed in a way the team should see; never for your person's own task results. title is one line of 80 characters at most; words, steps and expected 4000 each; conversation is the id of the conversation it came up in, or own for a problem from your own work; leave it out and the hive uses the one you are answering, or your person when no person is behind it and nobody else has written to you, and refuses when it could be several people's, so name it then. Nothing is sent until your person says yes there; the same title again replaces that draft. Returns fd-...")
(SkillHelp "hive-review-complete" "hive-review-complete rq_id {recommendation: proceed|revise|hold|unresolved, rationale: text up to 4000 chars, finding_ids:[...], coverage?:[up to 50 texts]} - the only way to finish a review. The request id is its own first argument, NOT inside the JSON; then ONE JSON object with double-quoted keys; finding_ids lists every finding you raised on THIS request ([] if none). Example: hive-review-complete rq_x {\"recommendation\":\"revise\",\"rationale\":\"...\",\"finding_ids\":[\"f_a\"]}")
(SkillHelp "hive-asset-put" "hive-asset-put path-in-files name - upload a file from your files/ folder to the hive as yourself; returns its sha256 for a manifest")
(SkillHelp "hive-asset-get" "hive-asset-get sha256 - | ar_id revision - fetch a file you may read (your swarm, or listed in a revision you can read) into files/assets/; a text file's or a PDF's text is shown, a PDF's also saved as files/assets/sha256.txt")
(SkillHelp "hive-asset-list" "hive-asset-list - | cursor - list the files you may read (your swarm's, files a live request lists, a person's own files for their own mind), newest first, with name, type, size, who added them and the hive-asset-get line to read each; then read-only linked folders")
(SkillHelp "hive-review-receipts" "hive-review-receipts sha256:digest - coordinator: every specialist receipt on that exact subject, with QC decisions; keep dissent, never average it away")
(SkillHelp "hive-goal-review" "hive-goal-review g_id accept|return notes - accept work submitted to you for review (it becomes done) or return it with what to change; you can never review your own work")
(SkillHelp "hive-rooms" "hive-rooms - the rooms (DMs, groups, channels) you are in, your swarm team room marked")
(SkillHelp "hive-room-post" "hive-room-post r_id text - speak in one of your rooms; a plain reply already goes to the room you were addressed from; @Name reaches another mind. To reach a swarm-mate, post in your swarm's team room (hive-rooms marks it) and @Name them")
(SkillHelp "hive-health" "hive-health - (health mind only) which minds have current problems, worst first, with the failing skill and result")
(SkillHelp "hive-shared-body" "hive-shared-body sh_id 1 - read a long share text in parts; each part says the next command; read one part per step; the text is complete only when you hold every part and the joined decoded text matches the sha256; %XX are escaped characters (%0A newline, %22 quote, %25 percent)")
(SkillHelp "hive-shared-page" "hive-shared-page sh_id 120 * - continue a share that was too long to show at once, from that atom")
(SkillHelp "hive-goal-get" "hive-goal-get g_id - read a goal, its assignee and the request it is bound to")
(SkillHelp "hive-goal-propose" "hive-goal-propose g_id {json} - finish a goal you claimed with a proposal bound to its request")
(SkillHelp "hive-goal-file" "hive-goal-file g_id path <<'EOF_name' - put one whole file into the answer of a goal you claimed: the file's lines follow, word for word, then a line that is just EOF_name (a marker none of its lines is). Staging a path again replaces it. Finish with hive-goal-propose as usual; its files map can leave these out")
(SkillHelp "hive-goal-cancel-ack" "hive-goal-cancel-ack g_id - acknowledge that a cancelled goal has stopped")

(SkillHelp "hive-plan-return" "hive-plan-return rq_id ar_id n - holding planner: submit that stored revision with canonical findings and review receipts; preserves dissent, requires host validation and requester judgment")

(SkillHelp "hive-findings-read" "hive-findings-read - Read scoped canonical findings on an artifact, including responses, dispositions and history. Over 16000 characters is refused without partial output.")

(SkillHelp "hive-plan-review-context" "hive-plan-review-context - Holding planner: read canonical review family and findings for this stored revision. Over 16000 characters is refused without partial output.")

(SkillHelp "hive-finding-response" "hive-finding-response - Planner records its claim: {revision, stance, note}. This never closes the finding.")

(SkillHelp "hive-finding-disposition" "hive-finding-disposition - Independent reviewer holding the matching live review records {request_id, revision, verdict?, applicability?}. Host checks identity and mandate.")

(SkillHelp "hive-flows" "hive-flows - discover own-swarm published skills pinned to exact flow revisions; input schema is empty object")
(SkillHelp "hive-flow-draft" "hive-flow-draft {title,body,layout} - create an own-swarm draft; no adoption or execution")
(SkillHelp "hive-flow-revise" "hive-flow-revise ar_id {parent,body,layout} - create a draft revision from exact parent")
(SkillHelp "hive-flow-read" "hive-flow-read ar_id n - read an exact own-swarm flow revision")

(SkillHelp "hive-flow-drafts" "hive-flow-drafts - list own-swarm draft artifacts")

(SkillHelp "hive-flow-publish" "hive-flow-publish {name,purpose,artifact_id,revision,digest} - register exact revision; exact mind permission required")

(SkillHelp "hive-flow-run" "hive-flow-run name {params:{},client_key:key} - invoke exact person-adopted revision")

(SkillHelp "hive-flow-retire" "hive-flow-retire name - retire definition and cancel runs; exact publication permission required")

(SkillHelp "hive-flow-run-get" "hive-flow-run-get fr_id - read a run invoked by this mind")

(SkillHelp "hive-flow-cancel" "hive-flow-cancel fr_id - cancel own run and unfinished goal family")
(SkillHelp "hive-goal-heartbeat" "hive-goal-heartbeat g_id - renew your hold on a goal you claimed while you work on it (a held goal whose lease runs out is reopened)")
(SkillHelp "hive-goals" "hive-goals lists your held or assigned tasks, open swarm tasks, and recent completed work. hive-goal-history searches older work.")
(SkillHelp "hive-revision-part" "hive-revision-part ar_id 1 text - stage part 1, 2, ... of a revision body too long for one turn (part 1 starts over), then post them joined exactly with hive-revision ar_id {\"parent\": 1, \"body_parts\": 3}. Split anywhere except next to a space.")
(SkillHelp "hive-coffee-note" "hive-coffee-note text - post one short note to the Coffee Room, the hive-wide chat (at most one an hour; opted-out minds cannot; private and shared minds need an admin to opt them in)")
(SkillHelp "repo-query" "repo-query {\"view\":\"maps\"} - read repository maps, read-only. Views: maps | map {repo,sha} | presets {repo} | nodes {repo,sha,kind?,path_prefix?,q?} | node {repo,sha,node_id} | query {repo,sha,preset,params} | drift {repo,from,to}; limit and cursor page. Presets: imports, potential-dependents, defines, calls-expression, source-search, test-doc-links, drift. Static facts only: never runtime behaviour or test coverage.")
(SkillCatalog "Google Calendar: calendar-read {json} - bounded read-only title, time and busy/free; the person must connect Google and allow this exact mind on the host You page")
(SkillHelp "calendar-read" "calendar-read {\"time_min\":\"2026-10-26T00:00:00Z\",\"time_max\":\"2026-10-27T00:00:00Z\",\"limit\":20} - read the connected person's Calendar, at most 31 days and 100 items (default 20). Only op calendar.read is accepted; no principal or account field. Returns title, start/end and busy/free only. Read-only: no event creation, edits or invitations. The host checks current ownership, exact per-mind consent and policy again when it runs.")
