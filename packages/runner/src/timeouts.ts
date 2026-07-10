/**
 * The two time bounds the run loop is built on. They live together because the
 * second is only correct *in terms of* the first, and holding them apart as two
 * literals made that relationship something a reader had to notice rather than
 * something the code enforced.
 */

/** Caps a single `claude` invocation (`execFileSync`'s `timeout`). */
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long an in-flight record may sit in one stage before the sweep presumes
 * it orphaned. Derived, not chosen: the agent call is the longest stage a run
 * can legitimately sit in, so the backstop must outlast it. Set this below
 * `AGENT_TIMEOUT_MS` and raising the agent timeout starts *shortening* runs —
 * the sweep reaps them mid-agent, which reads as a hang, not a timeout.
 *
 * The 2x is headroom for a stage that starts just before the clock is read.
 */
export const STALE_AFTER_MS = 2 * AGENT_TIMEOUT_MS;
