import { z } from 'zod'

// The value domain of a native config: a config value, a prior value, an expectation. It lives here
// rather than in a reader because the native editor and the readers both need it.
export type NativeValue = string | number | boolean | null | NativeValue[] | { [key: string]: NativeValue }

export const nativeValueSchema: z.ZodType<NativeValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(nativeValueSchema),
    z.record(z.string(), nativeValueSchema),
  ]),
)

export const nativeObjectSchema = z.record(z.string(), nativeValueSchema)
