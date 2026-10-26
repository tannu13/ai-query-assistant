import type { ZodError, ZodType, output } from 'zod';

import { ValidationFailedError, type FieldError } from './errors';

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0
    ? '(body)'
    : path
        .map((segment) =>
          typeof segment === 'number' ? `[${segment}]` : String(segment),
        )
        .join('.')
        .replace(/\.\[/g, '[');
}

export function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

/**
 * Parses with a zod schema or throws the typed validation error.
 *
 * `safeParse` rather than `parse` so routes never need a try/catch: the
 * layering rule is that handlers throw and exactly one middleware catches
 * (plan §4), and a route that has to catch a ZodError to re-throw it breaks
 * that rule for no benefit.
 */
export function parseOrThrow<T extends ZodType>(
  schema: T,
  value: unknown,
): output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationFailedError(toFieldErrors(result.error));
  }
  return result.data;
}
