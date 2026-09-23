import { z } from "zod/v3";

/**
 * Structured delegation intent for external work (NEXTIMPROVEMENTS §C).
 *
 * Free-form task input loses the user's delegation constraints between
 * conversation and execution ("same machine" drifts to a hardcoded host, a
 * requested harness is silently replaced by Hermes itself). Delegation
 * metadata travels alongside the task input so launch receipts can be checked
 * against what was actually requested.
 */

export const DELEGATION_HOSTS = ["exodia", "mac-mini"] as const;
export type DelegationHost = (typeof DELEGATION_HOSTS)[number];

export const DELEGATION_HARNESSES = ["herdr"] as const;
export type DelegationHarness = (typeof DELEGATION_HARNESSES)[number];

const MAX_OBJECTIVE_CHARS = 4_000;
const MAX_ACCEPTANCE_ITEMS = 8;
const MAX_ACCEPTANCE_CHARS = 500;

export const TaskDelegationSchema = z
  .object({
    targetHost: z.enum(DELEGATION_HOSTS),
    harness: z.enum(DELEGATION_HARNESSES),
    repository: z.string().min(1).max(256),
    objective: z.string().min(1).max(MAX_OBJECTIVE_CHARS),
    acceptanceCriteria: z.array(z.string().min(1).max(MAX_ACCEPTANCE_CHARS))
      .min(1)
      .max(MAX_ACCEPTANCE_ITEMS),
    /** Resolved reference when the user said "same machine" — never guessed. */
    referencedTaskId: z.string().regex(/^task_[0-9a-f]{32}$/u).optional(),
  })
  .strict();
export type TaskDelegation = z.infer<typeof TaskDelegationSchema>;

export function parseTaskDelegation(value: unknown): TaskDelegation {
  return TaskDelegationSchema.parse(value);
}
