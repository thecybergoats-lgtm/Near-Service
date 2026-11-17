// Param pipe for :id route params in the cities module.
// The house pipe (common/validation/uuid.pipe.ts) enforces UUID v4.
// Seeded ids are v4 too since Fix A (db/0021_fix_seed_uuids.sql rewrote
// the old version-0 seeds — Quetta is now
// 00000000-0000-4000-8000-0000aaaa0001). This module still validates the
// shape only (any version), with the same 422 VALIDATION_FAILED error
// shape, so a future non-v4 id would not 422 here.
import { ParseUUIDPipe } from '@nestjs/common';
import { Errors } from '../../common/errors/api-error';

export const cityUuidParamPipe = new ParseUUIDPipe({
  exceptionFactory: (error: string) =>
    Errors.unprocessable('VALIDATION_FAILED', 'Request validation failed', {
      fields: { id: [error] },
    }),
});
