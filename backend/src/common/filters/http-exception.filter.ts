import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ApiError, errorBody } from '../errors/api-error';
import { redactSecrets } from '../utils/log-redaction';
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const requestId = randomUUID();
    if (exception instanceof ApiError) {
      if (exception.retryAfterSeconds != null) res.set('Retry-After', String(exception.retryAfterSeconds));
      return res.status(exception.status).json(errorBody(exception, requestId));
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as Record<string, unknown>;
      return res.status(status).json({ error: { code: 'HTTP_ERROR', message: (body?.message as string) ?? exception.message, details: {} }, request_id: requestId });
    }
    // FIX 15(b): unhandled exceptions can carry request data (tokens,
    // codes) in their message/stack — redact before logging.
    console.error('[unhandled]', redactSecrets(exception instanceof Error ? `${exception.message}\n${exception.stack ?? ''}` : String(exception)));
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} }, request_id: requestId });
  }
}
