import { NestFactory } from '@nestjs/core';
import type { Env } from './config/env';

async function bootstrap() {
  // Validate ALL env vars FIRST (src/config/env.ts, zod). In production a
  // missing/short/default secret exits here with a clear message — the app
  // never boots on dangerous defaults.
  // NOTE: AppModule is dynamic-imported AFTER env validation on purpose:
  // it (transitively) imports env too, so a static import here would throw
  // during module loading, before this try/catch could print FATAL.
  let env: Env;
  try {
    env = (await import('./config/env')).env;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: ${(e as Error).message}`);
    process.exit(1);
  }
  const { AppModule } = await import('./app.module');
  const { AllExceptionsFilter } = await import('./common/filters/http-exception.filter');
  const { createValidationPipe } = await import('./common/validation/validation-pipe');
  const { buildCorsOptions } = await import('./config/cors');
  if (env.isProduction && env.otpDevMode) {
    // eslint-disable-next-line no-console
    console.warn('WARNING: OTP_DEV_MODE=true in production — OTP codes will still NEVER be logged (dev-mode logging is disabled in production).');
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  // FIX 6: validation failures are 422 VALIDATION_FAILED (see
  // src/common/validation/validation-pipe.ts), never Nest's default 400.
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  // FIX 12: CORS allowlist from env CORS_ORIGINS. In production an empty
  // allowlist means no browser origin is allowed (origin: false).
  app.enableCors(buildCorsOptions(env));
  const port = env.port;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Near Service API listening on :${port} (base /api/v1). OTP_DEV_MODE=${env.otpDevMode} — dev OTPs are console-logged only in non-production.`);
}
bootstrap().catch((e: Error) => {
  // eslint-disable-next-line no-console
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
