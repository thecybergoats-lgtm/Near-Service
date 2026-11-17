// The single ValidationPipe used by main.ts and by tests (FIX 6, Stage 2).
// Validation failures are 422 VALIDATION_FAILED in the shared error shape —
// NOT Nest's default 400 — with the failing fields listed in details:
//   { error: { code: 'VALIDATION_FAILED', message: '...',
//              details: { fields: { lat: ['lat must not be greater than 90'] } } } }
// Nested failures are flattened with dotted paths, e.g. 'items[0].amount'.
import { ValidationPipe, ValidationError } from '@nestjs/common';
import { Errors } from '../errors/api-error';

function walk(errors: ValidationError[], base: string, out: Record<string, string[]>): void {
  for (const e of errors) {
    // A class-level validator reports property '' — keep the parent path and
    // map the constraint to its real field name (see classLevelField).
    const isClassLevel = e.property === '';
    let path: string;
    if (isClassLevel) path = base;
    else if (!base) path = e.property;
    else if (/^\d+$/.test(e.property)) path = `${base}[${e.property}]`;
    else path = `${base}.${e.property}`;
    if (e.constraints) {
      const key = isClassLevel
        ? base
          ? `${base}.${classLevelField(e.constraints)}`
          : classLevelField(e.constraints)
        : path;
      out[key] = Object.values(e.constraints);
    }
    if (e.children?.length) walk(e.children, path, out);
  }
}

/** Field name a class-level (property '') constraint failure is reported under. */
function classLevelField(constraints: Record<string, string>): string {
  if ('atLeastOneCategory' in constraints) return 'category_id';
  if ('validServiceArea' in constraints) return 'service_area';
  return 'validation';
}

export function flattenValidationErrors(errors: ValidationError[]): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  walk(errors, '', fields);
  return fields;
}

export function validationExceptionFactory(errors: ValidationError[]) {
  const fields = flattenValidationErrors(errors);
  return Errors.unprocessable('VALIDATION_FAILED', 'Request validation failed', { fields });
}

/** Global pipe: whitelist + forbid unknown fields + transform, 422 on failure. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: validationExceptionFactory,
  });
}
