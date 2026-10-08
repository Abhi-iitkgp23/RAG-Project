import { z } from "zod";

const draftClaimSchema = z.strictObject({
  text: z.string().min(1),
  quote: z.string().min(1),
  chunkId: z.string().min(1),
});

/**
 * Model draft. `covered: false` is only valid with an empty claims array.
 * `covered: true` with `claims: []` is valid here; a later phase turns that
 * into the coverage refusal. Unknown keys are rejected.
 */
export const groundedDraftSchema = z
  .strictObject({
    covered: z.boolean(),
    claims: z.array(draftClaimSchema),
  })
  .superRefine((draft, ctx) => {
    if (draft.covered === false && draft.claims.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "covered: false requires an empty claims array",
        path: ["claims"],
      });
    }
  });

export const sourceSchema = z.strictObject({
  documentName: z.string().min(1),
  publisher: z.string().min(1),
  year: z.number().int(),
  url: z.string().min(1),
  sectionHeading: z.string().min(1),
});

export const boundClaimSchema = z.strictObject({
  text: z.string().min(1),
  source: sourceSchema,
});

export const chatRequestSchema = z.strictObject({
  conversationId: z.string().min(1).optional(),
  message: z.string(),
});
