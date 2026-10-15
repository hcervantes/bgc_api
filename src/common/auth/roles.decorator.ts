import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given UPPERCASE roles, e.g. @Roles('STAFF'). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
