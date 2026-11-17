import { Module } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { TeamsController } from './teams.controller';

/** Phase 3 teams: shop-owner teams, member invites, job assignment and
 *  worker-scoped job visibility (permissions enforced in TeamsService).
 *  NOTE: the integrator wires this module into AppModule; this file only
 *  declares the module itself. */
@Module({ controllers: [TeamsController], providers: [TeamsService], exports: [TeamsService] })
export class TeamsModule {}
