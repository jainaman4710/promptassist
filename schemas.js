// SCHEMAS — one Zod definition per pipeline call, used two ways:
//   1. zodToGeminiSchema() derives the request-time `responseSchema` Gemini is
//      constrained to generate against (replaces the old hand-written *_SCHEMA objects
//      in pipeline.js, which were a second, separately-maintained copy of the same shape
//      and could silently drift out of sync with what the prompt text actually promises).
//   2. validateOrThrow() checks the actual parsed response against the same definition
//      before any pipeline code touches it. Gemini's schema mode is generally reliable
//      but isn't a hard guarantee, and for the critique call specifically there was NO
//      response-time check of any kind before this file existed — see CritiqueResultSchema
//      below for why.
//
// Loaded via importScripts("vendor/zod.bundle.js", "schemas.js", ...) in background.js,
// and via a matching <script> tag order in sidepanel.html — must come after the Zod
// vendor bundle and before pipeline.js in both places.

const { z } = self.Zod;

// --- zodToGeminiSchema -------------------------------------------------------------
// Deliberately narrow: only understands the handful of Zod building blocks the schemas
// below actually use (object, string, enum, boolean, number). Anything else throws
// loudly at schema-definition time — this file's job is to keep one definition honest,
// not to be a general-purpose Zod-to-Gemini converter, so an unsupported shape should
// fail fast and obviously rather than silently producing a wrong request-time schema.
function zodToGeminiSchema(schema) {
  const def = schema._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = schema.shape;
      const properties = {};
      const required = [];
      for (const key of Object.keys(shape)) {
        properties[key] = zodToGeminiSchema(shape[key]);
        required.push(key);
      }
      return { type: "OBJECT", properties, required };
    }
    case "ZodString":
      return { type: "STRING" };
    case "ZodEnum":
      return { type: "STRING", enum: def.values };
    case "ZodBoolean":
      return { type: "BOOLEAN" };
    case "ZodNumber":
      return { type: "NUMBER" };
    default:
      throw new Error(
        `zodToGeminiSchema: unsupported Zod type "${def.typeName}" for Gemini request-time ` +
        `schema generation. This converter only handles object/string/enum/boolean/number ` +
        `on purpose — extend it deliberately when a schema below needs something new, ` +
        `don't guess at a mapping for it.`
      );
  }
}

// --- validateOrThrow -----------------------------------------------------------------
// Runs the parsed Gemini response through its Zod schema. On failure, throws an error
// that names exactly which field(s) were wrong and why, instead of letting a malformed
// response propagate as `undefined` into whatever code reads it next and fail somewhere
// far less diagnosable.
function validateOrThrow(zodSchema, data, label) {
  const result = zodSchema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `${label} response failed schema validation:\n${issues}\n` +
    `Raw response: ${JSON.stringify(data).slice(0, 500)}`
  );
}

// --- GRAMMAR ---------------------------------------------------------------------------
const GrammarResultSchema = z.object({
  corrected_prompt: z.string(),
  changed: z.boolean(),
  recap_addition: z.string(),
});

// --- AUDIT -------------------------------------------------------------------------------
const AuditResultSchema = z.object({
  anatomy: z.object({
    instruction: z.enum(["present", "weak", "missing"]),
    context: z.enum(["present", "weak", "missing"]),
    input_data: z.enum(["present", "weak", "missing", "not_applicable"]),
    output_indicator: z.enum(["present", "weak", "missing"]),
  }),
  task_domain: z.enum([
    "creative",
    "factual_qa",
    "analysis_reasoning",
    "coding",
    "summarization",
    "extraction",
    "other",
  ]),
  complexity: z.enum(["single_step", "multi_part"]),
  restructure: z.boolean(),
  technique_flags: z.object({
    role_assignment: z.boolean(),
    few_shot_examples: z.boolean(),
    chain_of_thought: z.boolean(),
    explicit_structure: z.boolean(),
    grounding_permission: z.boolean(),
  }),
  // Gemini's own schema has no min/max concept (NUMBER is unbounded), but Zod's does —
  // this is a real, free tightening over the old hand-written AUDIT_SCHEMA: a
  // confidence of 1.4 or -0.2 now fails validation instead of silently flowing through.
  confidence: z.number().min(0).max(1),
});

// --- STRUCTURAL ----------------------------------------------------------------------
const StructuralResultSchema = z.object({
  enhanced_prompt: z.string(),
  recap: z.string(),
});

// --- CHAIN OF THOUGHT ------------------------------------------------------------------
const CotResultSchema = z.object({
  enhanced_prompt: z.string(),
  recap_addition: z.string(),
});

// --- FEW-SHOT ----------------------------------------------------------------------------
const FewshotResultSchema = z.object({
  enhanced_prompt: z.string(),
  recap_addition: z.string(),
});

// --- CRITIQUE ------------------------------------------------------------------------------
// This is the one call that has never had ANY response-time shape check before this file.
// It also went through Gemini with no REQUEST-time schema either (see pipeline.js's own
// comment above CRITIQUE_SYSTEM_PROMPT) for a real reason: each technique's checklist value
// is the JSON boolean true/false OR the literal string "not_flagged" — three possible
// values across two JSON types — and Gemini's schema system requires one fixed type per
// field, so it can't express that union at all. Zod can, directly:
const TechniqueCheck = z.union([z.boolean(), z.literal("not_flagged")]);

const CritiqueResultSchema = z.object({
  checklist: z.object({
    anatomy_gaps_addressed: z.boolean(),
    flagged_techniques_applied: z.object({
      role_assignment: TechniqueCheck,
      few_shot_examples: TechniqueCheck,
      chain_of_thought: TechniqueCheck,
      explicit_structure: TechniqueCheck,
      grounding_permission: TechniqueCheck,
    }),
    no_unflagged_techniques_added: z.boolean(),
  }),
  passed: z.boolean(),
  // null when passed=true, a string correction when passed=false — .nullable() matches
  // that exactly, rather than the old code's silent trust that revised_prompt would be
  // either a string or null and nothing else.
  revised_prompt: z.string().nullable(),
  issue_summary: z.string(),
});

// This schema is NOT run through zodToGeminiSchema — the union above is exactly the shape
// that function can't express, and deliberately shouldn't try to. Gemini still gets no
// request-time schema for this call, same as before; only the response-time check is new.
