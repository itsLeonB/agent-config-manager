import { z } from 'zod'

// The value domain of a plan document and of any native config it reads: a config value, a prior
// value, an assertion's expectation. It lives here rather than in `plan.ts` because the native read
// side needs it too, and `plan.ts` already imports the readers.
export type PlanValue = string | number | boolean | null | PlanValue[] | { [key: string]: PlanValue }

export const planValueSchema: z.ZodType<PlanValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(planValueSchema),
    z.record(z.string(), planValueSchema),
  ]),
)

export const planObjectSchema = z.record(z.string(), planValueSchema)
