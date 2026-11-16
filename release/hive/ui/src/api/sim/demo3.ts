/**
 * SIM ONLY. Demo mode, round D3 (Surface): Studio, Tools, Code/Lab benchmarks and Health in plain demo mode
 * (`?sim=1`, the demo build). Every name, figure, design, slide, tool and version here is INVENTED; nothing reaches a
 * hive, a model or the network.
 */

// ---------------------------------------------------------------- Health

/** INVENTED: each mind's sleep rule (the hive's idle_sleep_minutes: asleep after that many quiet minutes; 0 never). */
export const DEMO_SLEEP_RULES: Record<string, number> = {
  a_vega01: 30,
  a_deneb2: 0,
  a_altr03: 10,
  a_mira04: 0,
  a_coral5: 45,
  a_nori06: 20,
  a_sedg07: 15,
  a_anvl09: 60,
  a_bell10: 15,
  a_qnch11: 5,
}

/** INVENTED: the one mind exactly at its spend cap, whose model calls the hive refuses while the demo runs. */
export const DEMO_SPEND_CAP = { mind: 'a_qnch11', cap_usd: 10, reached_minutes_ago: 15, refused_before: 2 }

// ---------------------------------------------------------------- Code and Lab benchmarks

/**
 * INVENTED: an example run that made a few cases' progress and then nothing more, still marked running (the Lab shows
 * it as stalled, with how long since its last case). Its cases are the recording's own first cases.
 */
export const DEMO_STALLED_RUN = { suite: 'bench-ops', cases: 4, startedMinutesAgo: 52 }

// ---------------------------------------------------------------- Studio

/**
 * INVENTED: where Studio (omegadesign) is switched on, and what the swarms own. Studio is on in Lyra and Kelp Commons
 * and held (not switched on) in Forge, so a person's Save there is refused 403 app_inactive as the host refuses it.
 * Lyra already owns the night-sky design and the open-day deck; Forge owns a design and a deck of its own.
 * Rows: [artifact id, kind, title, revision, minutes since its last revision].
 */
export const DEMO_STUDIO: {
  activations: { program: string; swarm_id: string; active: boolean }[]
  owned: Record<string, [string, string, string, number, number][]>
} = {
  activations: [
    { program: 'omegadesign', swarm_id: 's_lyra', active: true },
    { program: 'omegadesign', swarm_id: 's_kelp', active: true },
    { program: 'omegadesign', swarm_id: 's_forge', active: false },
  ],
  owned: {
    s_forge: [
      ['ar_simbenchcard', 'studio-source', 'Open bench night card', 1, 70],
      ['ar_simforgedeck', 'scene-deck', 'Parser review summary deck', 1, 95],
    ],
  },
}

/**
 * INVENTED: what D2's two extra swarms' minds talk about when the demo wakes them (their words and passing thoughts),
 * so a waking mind there has something of its own to say.
 */
export const DEMO_SWARM_WORDS: Record<string, { vocab: string[]; musings: string[] }> = {
  s_drift: {
    vocab: ['pebble', 'shingle', 'tideline', 'photo', 'blurry', 'label', 'groyne'],
    musings: ['Three photos from the north groyne look blurry; I will flag them.', 'The tideline photos sort neatly by date.'],
  },
  s_salt: {
    vocab: ['heron', 'redshank', 'hide', 'count', 'marsh'],
    musings: ['The last marsh count is filed; nothing new to add.'],
  },
}
