// Liveness challenge flow (Phase 3, verification item 6).
//
// The server issues a short-lived challenge: a random sequence of 3
// distinct actions (blink / smile / turn_head_left / turn_head_right /
// nod / open_mouth) that the provider must perform on camera, in order.
// The mobile app records which actions it observed and posts them back.
// This is a CHALLENGE/RESPONSE record, not a biometric liveness verdict:
// the local implementation trusts the client's reported observations
// (there is no on-device ML model in this environment), so a passed
// challenge is recorded as `liveness: 'challenge_passed'` and is only
// ever supporting evidence for the officer — it never approves a
// provider on its own. A production vendor (e.g. AWS Rekognition
// FaceLiveness, or the device's own liveness SDK) replaces the
// observation-trust step; see README.md.

import * as crypto from 'crypto';
import { Errors } from '../../common/errors/api-error';

export const LIVENESS_ACTIONS = ['blink', 'smile', 'turn_head_left', 'turn_head_right', 'nod', 'open_mouth'] as const;
export type LivenessAction = (typeof LIVENESS_ACTIONS)[number];
export type LivenessStatus = 'pending' | 'passed' | 'failed' | 'expired';

export const LIVENESS_CHALLENGE_ACTIONS = 3;
export const LIVENESS_TTL_SECONDS = 300; // 5 minutes
export const LIVENESS_MAX_ATTEMPTS = 3;

/** Random sequence of 3 distinct actions. Pure apart from crypto RNG. */
export function generateChallengeActions(count = LIVENESS_CHALLENGE_ACTIONS): LivenessAction[] {
  const pool = [...LIVENESS_ACTIONS];
  const out: LivenessAction[] = [];
  while (out.length < count && pool.length) {
    out.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  }
  return out;
}

export function isValidLivenessAction(value: unknown): value is LivenessAction {
  return typeof value === 'string' && (LIVENESS_ACTIONS as readonly string[]).includes(value);
}

/** True when every required action appears in `observed`, in the same
 *  order (other actions may appear in between — the camera may see extra
 *  movement). Pure function; unit-tested directly. */
export function actionsMatchInOrder(required: LivenessAction[], observed: string[]): boolean {
  let i = 0;
  for (const action of observed) {
    if (i < required.length && action === required[i]) i += 1;
  }
  return i === required.length;
}

export interface LivenessCheckInput {
  required: LivenessAction[];
  observed: string[];
  attemptsUsed: number;
  expiresAt: Date;
  now?: Date;
}

export type LivenessCheckOutcome =
  | { passed: true; reason: 'all_actions_observed_in_order' }
  | { passed: false; reason: 'expired' | 'too_many_attempts' | 'missing_or_out_of_order_actions' };

/** Pure decision rule for one response attempt. Expiry and attempt-limit
 *  are checked before the action sequence, so a stale challenge can never
 *  pass on a lucky guess. */
export function checkLivenessResponse(input: LivenessCheckInput): LivenessCheckOutcome {
  const now = input.now ?? new Date();
  if (now > input.expiresAt) return { passed: false, reason: 'expired' };
  if (input.attemptsUsed >= LIVENESS_MAX_ATTEMPTS) return { passed: false, reason: 'too_many_attempts' };
  if (!actionsMatchInOrder(input.required, input.observed)) {
    return { passed: false, reason: 'missing_or_out_of_order_actions' };
  }
  return { passed: true, reason: 'all_actions_observed_in_order' };
}

/** Validate the observed-actions array from the client before any DB
 *  work: non-empty, at most 12 entries, every entry a known action. */
export function validateObservedActions(observed: unknown): LivenessAction[] {
  if (!Array.isArray(observed) || observed.length === 0 || observed.length > 12) {
    throw Errors.unprocessable('VALIDATION_FAILED', 'observed_actions must be a non-empty array of at most 12 actions');
  }
  for (const action of observed) {
    if (!isValidLivenessAction(action)) {
      throw Errors.unprocessable('VALIDATION_FAILED', `Unknown liveness action: ${String(action)}`);
    }
  }
  return observed as LivenessAction[];
}
