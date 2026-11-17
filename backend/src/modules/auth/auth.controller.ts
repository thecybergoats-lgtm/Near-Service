import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { OtpRequestDto, OtpVerifyDto, RefreshDto, LogoutDto } from './dto';
import { Public } from '../../common/guards/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  @Public() @RateLimit('otp-request') @Post('otp/request') @HttpCode(202) requestOtp(@Body() dto: OtpRequestDto) { return this.auth.requestOtp(dto.phone, dto.device_fingerprint); }
  @Public() @RateLimit('otp-verify') @Post('otp/verify') @HttpCode(200) verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: Request) {
    // FIX 3(c): the client IP feeds the per-IP verify-attempt limit.
    return this.auth.verifyOtp(dto.phone, dto.code, dto.device_fingerprint, dto.full_name, dto.language, req.ip);
  }
  @Public() @RateLimit('refresh') @Post('refresh') @HttpCode(200) refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refresh_token); }
  @Post('logout') @HttpCode(204) async logout(@Body() dto: LogoutDto, @Res() res: Response) { await this.auth.logout(dto.refresh_token); res.status(204).send(); }
}
