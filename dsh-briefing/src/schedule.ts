/**
 * Daily-schedule helpers, re-exported from `dsh-household`.
 *
 * The implementation moved to `dsh-household` when `dsh-planner` needed the same
 * arithmetic. It lives beside `zonedToInstant` there, which is what makes it
 * daylight-saving correct, and one copy means the next fix to it cannot be applied
 * to one caller and forgotten for the other.
 *
 * @module dsh-briefing/schedule
 */

export { nextRun, parseTimeOfDay } from 'dsh-household'
export type { ScheduleClock, TimeOfDay } from 'dsh-household'
