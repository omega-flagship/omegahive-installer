/**
 * Health's idle question reaches the mind as "[HEALTH-QUESTION hq_…] text" (hive/core/health.py HEALTH_QUESTION_TAG):
 * the mind needs the id to know which question it answers, a person never sees it. The hive removes it where answers
 * and events leave for people (health.people_message, only for a verified Health question) and marks the message
 * health_check, for each look's own "Health check" label (ui/HealthCheckLabel). The client rewrites nothing.
 */

/** Whether a message is Health's question, as the hive marked it. */
export const healthCheck = (m: unknown): boolean => !!m && typeof m === 'object' && (m as { health_check?: unknown }).health_check === true
