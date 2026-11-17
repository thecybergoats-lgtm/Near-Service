import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WalletService } from './wallet.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { CursorQueryDto, IsMoney } from '../../common/validation/validators';
import { uuidParamPipe } from '../../common/validation/uuid.pipe';

export class TopupDto {
  @IsEnum(['jazzcash', 'easypaisa']) method!: 'jazzcash' | 'easypaisa';
  @IsMoney() amount_pkr!: number;
  @IsString() @Matches(/^\+92\d{10}$/, { message: 'phone must be +92 followed by 10 digits' }) phone!: string;
}
export class ConfirmTopupDto { @IsString() @IsNotEmpty() @MaxLength(200) payment_id!: string; }
export class PayWalletDto { @IsOptional() @IsString() @MaxLength(40) promo_code?: string; }
export class WalletTransactionsQueryDto extends CursorQueryDto {}

@Controller()
export class WalletController {
  constructor(private svc: WalletService) {}

  @Get('wallet') wallet(@CurrentUser() u: AuthUser) { return this.svc.getWalletView(u.id); }

  @Get('wallet/transactions') transactions(
    @CurrentUser() u: AuthUser,
    @Query() q: WalletTransactionsQueryDto,
  ) {
    return this.svc.listTransactions(u.id, q.cursor, q.limit ?? 20);
  }

  @Get('payments/methods') methods() { return this.svc.getPaymentMethods(); }

  @Post('wallet/topup') @HttpCode(200) topup(
    @CurrentUser() u: AuthUser,
    @Body() dto: TopupDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.initiateTopup(u.id, dto.method, dto.amount_pkr, dto.phone, key);
  }

  @Post('wallet/topup/confirm') @HttpCode(200) confirmTopup(
    @CurrentUser() u: AuthUser,
    @Body() dto: ConfirmTopupDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.svc.confirmTopup(u.id, dto.payment_id, key);
  }

  @Post('jobs/:id/pay-wallet') @HttpCode(200) payWallet(
    @CurrentUser() u: AuthUser,
    @Param('id', uuidParamPipe) id: string,
    @Body() dto: PayWalletDto,
    @Headers('idempotency-key') key?: string,
    @Headers('x-device-fingerprint') device?: string,
  ) {
    return this.svc.payWithWallet(id, u.id, dto.promo_code, device, key);
  }
}
