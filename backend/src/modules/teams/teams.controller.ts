import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsString, IsUUID, MaxLength } from 'class-validator';
import { TeamsService } from './teams.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class CreateTeamDto {
  @IsString() @MaxLength(100) name!: string;
}
export class InviteMemberDto {
  @IsUUID() user_id!: string;
  @IsEnum(['manager', 'worker']) role!: 'manager' | 'worker';
}
export class AssignJobDto {
  @IsUUID() worker_user_id!: string;
}

@Controller()
export class TeamsController {
  constructor(private svc: TeamsService) {}

  @Post('teams') @HttpCode(201) create(@CurrentUser() u: AuthUser, @Body() dto: CreateTeamDto) {
    return this.svc.createTeam(u.id, dto.name);
  }

  @Get('teams') mine(@CurrentUser() u: AuthUser) { return this.svc.listMyTeams(u.id); }

  @Get('teams/:id') get(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getTeam(id, u.id);
  }

  @Post('teams/:id/members') @HttpCode(201) invite(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: InviteMemberDto,
  ) { return this.svc.inviteMember(id, u.id, dto.user_id, dto.role); }

  @Post('teams/:id/members/accept') @HttpCode(200) accept(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
  ) { return this.svc.acceptInvite(id, u.id); }

  @Delete('teams/:id/members/:memberId') remove(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('memberId', uuidParamPipe) memberId: string,
  ) { return this.svc.removeMember(id, u.id, memberId); }

  @Get('teams/:id/members') members(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.listMembers(id, u.id);
  }

  @Post('teams/:id/jobs/:jobId/assign') @HttpCode(200) assign(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('jobId', uuidParamPipe) jobId: string, @Body() dto: AssignJobDto,
  ) { return this.svc.assignJob(id, u.id, jobId, dto.worker_user_id); }

  @Delete('teams/:id/jobs/:jobId/assignment') unassign(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('jobId', uuidParamPipe) jobId: string,
  ) { return this.svc.unassignJob(id, u.id, jobId); }

  @Get('teams/:id/jobs') jobs(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Query() q: CursorQueryDto,
  ) { return this.svc.listTeamJobs(id, u.id, q.cursor, q.limit ?? 20); }

  @Get('teams/:id/jobs/:jobId') job(
    @CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string,
    @Param('jobId', uuidParamPipe) jobId: string,
  ) { return this.svc.getTeamJob(id, u.id, jobId); }

  @Get('teams/:id/earnings') earnings(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getTeamEarnings(id, u.id);
  }
}
