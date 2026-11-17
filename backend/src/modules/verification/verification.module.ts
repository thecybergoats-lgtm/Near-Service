import { Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { VerificationController } from './verification.controller';

/** Phase 3 verification: face-match + liveness + OCR assist.
 *  VerificationService defaults to the LOCAL heuristic face-match
 *  provider (no vendor, no key — see face-match.ts and README.md). To
 *  use a real vendor, construct VerificationService with a
 *  FaceMatchProvider implementation instead of relying on the default;
 *  the controller and service need no other change.
 *
 *  NOTE FOR THE INTEGRATOR: this module is NOT imported by AppModule
 *  yet — app.module.ts is owned by the integrator. Add
 *  `VerificationModule` to its imports list (one line, no other change)
 *  and add the routes listed in README.md to backend/openapi.yaml. */
@Module({
  controllers: [VerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
