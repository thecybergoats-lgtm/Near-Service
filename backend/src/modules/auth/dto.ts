import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export const LANGUAGE_VALUES = ['ur', 'ur-roman', 'en'] as const;

export class OtpRequestDto {
  @IsString() @IsNotEmpty() @Matches(/^\+92\d{10}$/, { message: 'phone must be +92 followed by 10 digits' })
  phone!: string;
  @IsOptional() @IsString() @MaxLength(128) device_fingerprint?: string;
}
export class OtpVerifyDto {
  @IsString() @IsNotEmpty() @Matches(/^\+92\d{10}$/, { message: 'phone must be +92 followed by 10 digits' })
  phone!: string;
  @IsString() @IsNotEmpty() @Matches(/^\d{4,8}$/) code!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) device_fingerprint!: string; // required by OpenAPI v1.1
  @IsOptional() @IsString() @MaxLength(100) full_name?: string;
  @IsOptional() @IsString() @IsIn([...LANGUAGE_VALUES]) language?: string;
}
export class RefreshDto { @IsString() @IsNotEmpty() @MaxLength(4096) refresh_token!: string; }
export class LogoutDto { @IsString() @IsNotEmpty() @MaxLength(4096) refresh_token!: string; }
