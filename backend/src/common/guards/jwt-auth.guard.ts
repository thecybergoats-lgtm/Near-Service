import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { Errors } from '../errors/api-error';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw Errors.unauthorized('Missing Bearer token');
    try {
      const payload = jwt.verify(header.slice(7), env.jwtAccessSecret) as Record<string, unknown>;
      req.user = { id: payload.sub, phone: payload.phone, roles: (payload.roles as string[]) ?? ['customer'], profile: payload.profile };
      return true;
    } catch { throw Errors.unauthorized('Invalid or expired access token'); }
  }
}
