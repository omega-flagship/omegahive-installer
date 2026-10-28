> **Legacy / reference.** Inherited from OmegaClaw Core or an earlier session; outdated compared with the current hive and apps. See `LEGACY.md` at the repo root.

# Reference — Memory Skills

Core embedding memory is defined in `src/memory.metta`. Structured memory affordances are defined in `src/skills_memory.metta` and advertised through `src/skill_catalog.metta`.

All four skills accept quoted string arguments. Variables are not permitted in LLM-generated calls.

---

## `remember`

### Signature
```metta
(remember "string")
```

### Purpose
Store a string in long-term embedding memory as the triplet `(timestamp, atom, embedding)`.

### Parameters
- `string` — the text to remember. Use short, self-contained phrases for best recall.

### Returns
The result of the ChromaDB write (internally). The agent treats a successful call as an effectful step.

### Examples
```metta
(remember "user prefers dark mode")
(remember "to deploy: run make release then docker push")
```

### Notes / Limits
- Text is passed through `string-safe` before embedding, which escapes newlines, quotes, and apostrophes.
- Embedding provider is selected by `embeddingprovider` (`Local` or `OpenAI`).
- Nothing deduplicates automatically — repeated `remember` calls store multiple items.

---

## `query`

### Signature
```metta
(query "string")
```

### Purpose
Return up to `maxRecallItems` memory entries whose embeddings are closest to the embedding of `string`.

### Parameters
- `string` — a short descriptive phrase. Over-long queries dilute similarity scores.

### Returns
A list-shaped result containing the nearest memory items.

### Examples
```metta
(query "deployment steps")
(query "user preferences")
```

### Notes / Limits
- `maxRecallItems` default is 20 (see `initMemory`).
- Similarity is purely embedding-based; exact string match is not guaranteed.

---

## `episodes`

### Signature
```metta
(episodes "YYYY-MM-DD HH:MM:SS")
```

### Purpose
Return `maxEpisodeRecallLines` lines of the episodic trace centered on the given timestamp.

### Parameters
- `timestamp` — must match the format produced by `get_time_as_string`.

### Returns
A block of lines from `memory/history.metta`.

### Examples
```metta
(episodes "2026-04-15 14:30:00")
```

### Notes / Limits
- Implemented by `helper.around_time`.
- Useful for answering questions like "what was I doing around X?"

---

## `pin`

### Signature
```metta
(pin "string")
```

### Purpose
Append a one-line volatile continuity vector to the episodic trace so the next
cycle can stay oriented. `pin` is for live state: what mode the agent is in,
what goal it is carrying, what self-directed practice or metagoal is active,
what open loop remains, and what condition should be checked next.

### Parameters
- `string` — one line of live working state. Prefer compact pointers into
  symbolic spaces over prose. For example, point to `agenda/<goal>`,
  `beliefs/<self-belief>`, or `persistent/<self-model>` rather than copying the
  whole goal or belief into pin.

### Returns
Success / failure of the append.

### Examples
```metta
(pin "FOCUSED | primary: agenda/family-lighting -> verify scene | meta: beliefs/truth-first -> separate observed/inferred | secondary: none | open-loop: report owed | constraint: no confabulation | wake/check: next loop")
(pin "REBOOT | primary: agenda/weave-test -> confirm pid | meta: persistent/self-model -> preserve continuity | secondary: none | open-loop: previous pid/cycle | constraint: no duplicate process | wake/check: current-swipl-pid")
(pin "ASLEEP | primary: agenda/rest -> wake on inbound | meta: beliefs/energy-care -> conserve without losing reply debt | secondary: none | open-loop: none | constraint: receive polling stays on | wake/check: message or scheduled wake")
```

### Notes / Limits
- `pin` is not semantically indexed — it only influences the next few turns through the rolling `HISTORY` window (`maxHistory` characters).
- For anything you want to recall days later, use `remember` instead.
- `pin` is not a diary, durable fact store, or full task manager. Use
  `agenda-goal` for continuing goals, `belief-claim` for revisable beliefs,
  `world-fact` for stable facts, `event-note` for meaningful events, and
  `persistent-note` for rare identity/core principles.
- The metagoal field is self-chosen. It may point into beliefs, persistent
  self-model, or an agenda self-goal. Do not treat example labels as predefined
  metagoals.
- If the same pin repeats several cycles, either act, revise the pin, sleep
  deliberately, or record the blockage.
