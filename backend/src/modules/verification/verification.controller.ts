import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { Roles } from '../../common/guards/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { CursorQueryDto } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';
import { FaceMatchDto, FaceMatchOverrideDto, LivenessRespondDto, OcrConfirmDto, OcrExtractDto } from './dto';

export class VerificationQueueQueryDto extends CursorQueryDto {}

@Controller('verification')
export class VerificationController {
  constructor(private svc: VerificationService) {}

  // ---- Face-match (provider submits; officer reads/overrides) ----
  @Roles('provider') @Post('face-match')
  faceMatch(@CurrentUser() u: AuthUser, @Body() dto: FaceMatchDto) {
    return this.svc.submitFaceMatch(u.id, dto);
  }
  @Roles('provider', 'super_admin', 'verification_officer') @Get('face-match/:id')
  getFaceMatch(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getFaceMatch(u.id, id, u.roles);
  }
  @Roles('super_admin', 'verification_officer') @Post('face-match/:id/override')
  overrideFaceMatch(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: FaceMatchOverrideDto) {
    return this.svc.overrideFaceMatch(u.id, id, dto.decision, dto.note);
  }

  // ---- Liveness challenge/response (provider) ----
  @Roles('provider') @Post('liveness/start')
  startLiveness(@CurrentUser() u: AuthUser) {
    return this.svc.startLiveness(u.id);
  }
  @Roles('provider') @Post('liveness/:id/respond')
  respondLiveness(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: LivenessRespondDto) {
    return this.svc.respondLiveness(u.id, id, dto.observed_actions);
  }
  @Roles('provider', 'super_admin', 'verification_officer') @Get('liveness/:id')
  getLiveness(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string) {
    return this.svc.getLiveness(u.id, id, u.roles);
  }

  // ---- OCR assist (officers only) ----
  @Roles('super_admin', 'verification_officer') @Post('ocr/extract')
  extractOcr(@CurrentUser() u: AuthUser, @Body() dto: OcrExtractDto) {
    return this.svc.extractOcr(u.id, dto);
  }
  @Roles('super_admin', 'verification_officer') @Post('ocr/:id/confirm')
  confirmOcr(@CurrentUser() u: AuthUser, @Param('id', uuidParamPipe) id: string, @Body() dto: OcrConfirmDto) {
    return this.svc.confirmOcr(u.id, id, dto);
  }

  // ---- Officer review queue (pre-filled with all three assists) ----
  @Roles('super_admin', 'verification_officer') @Get('review-queue')
  reviewQueue(@Query() q: VerificationQueueQueryDto) {
    return this.svc.reviewQueue(q.cursor, q.limit ?? 20);
  }
  @Roles('super_admin', 'verification_officer') @Get('providers/:id/evidence')
  evidence(@Param('id', uuidParamPipe) id: string) {
    return this.svc.evidenceForProvider(id);
  }
}
