// Param pipe for :id route params (FIX 6, Stage 2). A malformed UUID in the
// path is a validation failure, so it is 422 VALIDATION_FAILED in the shared
// error shape — not Nest's default 400 from ParseUUIDPipe.
import { ParseUUIDPipe } from '@nestjs/common';
import { Errors } from '../errors/api-error';

export const uuidParamPipe = new ParseUUIDPipe({
  version: '4',
  exceptionFactory: (error: string) =>
    Errors.unprocessable('VALIDATION_FAILED', 'Request validation failed', {
      fields: { id: [error] },
    }),
});
