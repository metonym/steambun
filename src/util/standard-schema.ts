// The Standard Schema interface (https://standardschema.dev), copied rather
// than depended on, as the spec recommends. zod (3.24+), valibot (1.0+),
// arktype (2.0+), and others implement it, so steambun validates with
// whichever the project already uses.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1.Result<Output>
      | Promise<StandardSchemaV1.Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export declare namespace StandardSchemaV1 {
  type Result<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: ReadonlyArray<Issue> };

  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
  }

  type InferInput<S extends StandardSchemaV1> = NonNullable<
    S["~standard"]["types"]
  >["input"];

  type InferOutput<S extends StandardSchemaV1> = NonNullable<
    S["~standard"]["types"]
  >["output"];
}

export interface ValidationIssue {
  message: string;
  /** Dotted path into the validated value, e.g. `"items.0.id"`; `""` for the root. */
  path: string;
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as StandardSchemaV1)["~standard"]?.validate === "function"
  );
}

/** Runs a schema and flattens its issues' paths to dotted strings. */
export async function validateWith<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<
  | { ok: true; value: StandardSchemaV1.InferOutput<S> }
  | { ok: false; issues: ValidationIssue[] }
> {
  const result = await schema["~standard"].validate(value);
  if (!result.issues) return { ok: true, value: result.value };
  return {
    ok: false,
    issues: result.issues.map((issue) => ({
      message: issue.message,
      path: (issue.path ?? [])
        .map((segment) =>
          String(typeof segment === "object" ? segment.key : segment),
        )
        .join("."),
    })),
  };
}
