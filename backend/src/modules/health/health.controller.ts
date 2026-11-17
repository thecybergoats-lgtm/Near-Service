// Health + readiness — FIX 13 (Stage 3).
//
//   GET /health — 200 whenever the process is up. No auth, no rate limit.
//   GET /ready  — 200 only when Postgres AND Redis both answer; 503
//                 otherwise (body names the failing dependency).
//
// Both are @Public() (the global JwtAuthGuard would otherwise 401 them)
// and carry no @RateLimit metadata (the global RateLimitGuard only acts
// on handlers that carry it, so health probes are never throttled).
// docker-compose.yml uses /ready as the backend healthcheck.
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../database/redis.service';
import { Public } from '../../common/guards/public.decorator';

@Controller()
export class HealthController {
  constructor(
    private db: DatabaseService,
    private redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'near-service-backend',
      uptime_seconds: Math.floor(process.uptime()),
    };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    const [postgres, redis] = await Promise.all([this.db.ping(), this.redis.ping()]);
    const ready = postgres && redis;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      dependencies: { postgres: postgres ? 'up' : 'down', redis: redis ? 'up' : 'down' },
    });
  }
}
