import { SetMetadata } from '@nestjs/common';
export type RoleName = 'customer' | 'provider' | 'super_admin' | 'verification_officer' | 'support_agent' | 'finance' | 'marketing' | 'city_manager';
export const ROLES_KEY = 'roles';
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
