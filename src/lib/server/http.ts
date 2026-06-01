import type { ZodType } from "zod";

export async function parseJsonBody<T>(request: Request, schema: ZodType<T>) {
  const json = await request.json().catch(() => null);
  const parsed = schema.safeParse(json);

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid request body.";
    return {
      data: null as null,
      error: Response.json({ error: message }, { status: 400 }),
    };
  }

  return {
    data: parsed.data,
    error: null as null,
  };
}
