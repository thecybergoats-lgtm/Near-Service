import { createParamDecorator, ExecutionContext } from '@nestjs/common';
export interface AuthUser { id: string; phone: string; roles: string[]; profile?: 'customer' | 'provider'; }
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});
