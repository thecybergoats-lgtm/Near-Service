import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AddressesController } from './addresses.controller';
import { MeController } from './me.controller';
@Module({ controllers: [AuthController, AddressesController, MeController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
