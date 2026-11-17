// Shared class-validator helpers (FIX 6, Stage 2).
// Every controller body / query DTO in the API should be built from these so
// the rules match OpenAPI v1.2 in one place:
//   lat -90..90, lng -180..180, PKR money > 0 with <= 2 decimals and
//   <= 10,000,000, string length caps, UUID ids, cursor/limit pagination.
import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateNested,
  ValidationArguments,
  ValidationOptions,
  IsDefined,
} from 'class-validator';

/** PKR money: positive, at most 2 decimal places, at most 10,000,000. */
export function IsMoney(validationOptions?: ValidationOptions) {
  return applyDecorators(
    IsNumber({ maxDecimalPlaces: 2 }, validationOptions),
    IsPositive(validationOptions),
    Max(10_000_000, validationOptions),
  );
}

/** Latitude: -90..90. */
export function IsLat(validationOptions?: ValidationOptions) {
  return applyDecorators(IsNumber({}, validationOptions), Min(-90, validationOptions), Max(90, validationOptions));
}

/** Longitude: -180..180. */
export function IsLng(validationOptions?: ValidationOptions) {
  return applyDecorators(IsNumber({}, validationOptions), Min(-180, validationOptions), Max(180, validationOptions));
}

/**
 * Query-string -> number. '' / missing stays undefined (so @IsOptional works
 * and a required field fails as missing); a non-numeric string becomes NaN,
 * which @IsNumber() rejects -> 422 VALIDATION_FAILED.
 */
export function ToNumber() {
  return Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'number') return value;
    return Number(value);
  });
}

/** Query-string -> boolean ('true'/'1' -> true, anything else -> false). */
export function ToBoolean() {
  return Transform(({ value }: { value: unknown }) => value === true || value === 'true' || value === '1');
}

/**
 * Class-level rule (OpenAPI v1.2): at least one of category_id / category_slug
 * must be present. "Both present must agree" cannot be checked in a DTO (it
 * needs a DB lookup) — resolveCategoryId enforces agreement in the service
 * and already throws 422 (CATEGORY_MISMATCH); a missing pair is 422 here.
 */
export function AtLeastOneCategory(validationOptions?: ValidationOptions) {
  return function (target: object) {
    registerDecorator({
      name: 'atLeastOneCategory',
      // Class decorator: target IS the constructor; register on it directly.
      // propertyName is '' ON PURPOSE: attaching this to 'category_id'
      // would make @IsOptional() on that property skip the check entirely
      // (class-validator skips a property's validations when its value is
      // nil and @IsOptional is set). The empty property is mapped back to
      // 'category_id' in flattenValidationErrors (validation-pipe.ts).
      target: target as unknown as new (...args: unknown[]) => unknown,
      propertyName: '',
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const o = args.object as Record<string, unknown>;
          return Boolean(o.category_id ?? o.category_slug);
        },
        defaultMessage() {
          return 'Provide category_id (UUID) or category_slug';
        },
      },
    });
  };
}

/**
 * Class-level rule (OpenAPI v1.2 ServiceArea): exactly one shape is allowed —
 * center + radius_km (circular area) OR polygon. Sending both, or neither,
 * is 422 VALIDATION_FAILED.
 */
export function ValidServiceArea(validationOptions?: ValidationOptions) {
  return function (target: object) {
    registerDecorator({
      name: 'validServiceArea',
      // Class decorator: target IS the constructor; register on it directly.
      target: target as unknown as new (...args: unknown[]) => unknown,
      propertyName: 'service_area',
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const o = args.object as Record<string, unknown>;
          const circular = Boolean(o.center) && o.radius_km !== undefined && o.radius_km !== null;
          const poly = Boolean(o.polygon);
          return circular !== poly;
        },
        defaultMessage() {
          return 'Provide either center + radius_km or polygon, not both and not neither';
        },
      },
    });
  };
}

/** Shared cursor pagination query: limit 1..100 (default 20), opaque cursor. */
export class CursorQueryDto {
  @IsOptional()
  @ToNumber()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

/** A nested { lat, lng } object with geo bounds (service-area centre). */
export class LatLngDto {
  @IsDefined()
  @IsLat()
  lat!: number;

  @IsDefined()
  @IsLng()
  lng!: number;
}

/** Helper for nested DTO arrays/objects: @ValidateNested + @Type in one. */
export function IsNestedDto(type: new () => unknown) {
  return applyDecorators(ValidateNested(), Type(() => type as never));
}
