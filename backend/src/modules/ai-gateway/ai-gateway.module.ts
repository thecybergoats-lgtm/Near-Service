import { Module } from '@nestjs/common';
import { AiGatewayService } from './ai-gateway.service';
import { AiGatewayController } from './ai-gateway.controller';

/** AI Gateway (Phase 3 items 1 + 9). Own module — NOT wired into
 *  AppModule here: the integrator adds `AiGatewayModule` to
 *  backend/src/app.module.ts (shared file) and registers its routes in
 *  backend/openapi.yaml. See the route list in README.md. */
@Module({ controllers: [AiGatewayController], providers: [AiGatewayService], exports: [AiGatewayService] })
export class AiGatewayModule {}
