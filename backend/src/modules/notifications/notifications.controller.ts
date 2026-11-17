import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

export class RegisterDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(512) device_token!: string;
  @IsEnum(['android', 'ios']) platform!: 'android' | 'ios';
}
export class NotificationPreferencesDto {
  @IsBoolean() push_enabled!: boolean;
}

@Controller()
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  /** Register the caller's FCM device token (upsert per user+device).
   *  The response never echoes the token. */
  @Post('devices/register') register(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.svc.registerDevice(u.id, dto.device_token, dto.platform);
  }

  @Get('users/me/notification-preferences') preferences(@CurrentUser() u: AuthUser) {
    return this.svc.getPreferences(u.id);
  }

  @Patch('users/me/notification-preferences') updatePreferences(
    @CurrentUser() u: AuthUser, @Body() dto: NotificationPreferencesDto) {
    return this.svc.setPreferences(u.id, dto.push_enabled);
  }
}
