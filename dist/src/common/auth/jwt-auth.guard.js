"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtAuthGuard = exports.Public = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const jwt_1 = require("@nestjs/jwt");
const roles_decorator_1 = require("./roles.decorator");
const Public = () => (0, common_1.SetMetadata)('isPublic', true);
exports.Public = Public;
let JwtAuthGuard = class JwtAuthGuard {
    reflector;
    jwt;
    constructor(reflector) {
        this.reflector = reflector;
        const publicKey = process.env.JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
        if (!publicKey) {
            throw new Error('JWT_PUBLIC_KEY is not set — cannot verify tokens. Aborting boot.');
        }
        this.jwt = new jwt_1.JwtService({
            publicKey,
            verifyOptions: {
                algorithms: ['RS256'],
                issuer: process.env.JWT_ISSUER ?? 'bgc-portal',
                audience: process.env.JWT_AUDIENCE ?? 'bgc-api',
            },
        });
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        if (this.reflector.getAllAndOverride('isPublic', [context.getHandler(), context.getClass()])) {
            return true;
        }
        const auth = request.headers['authorization'];
        if (!auth?.startsWith('Bearer '))
            throw new common_1.UnauthorizedException();
        const token = auth.slice(7);
        let payload;
        try {
            payload = await this.jwt.verifyAsync(token);
        }
        catch {
            throw new common_1.UnauthorizedException();
        }
        const user = {
            sub: payload.sub,
            role: payload.role,
            clients: Array.isArray(payload.clients) ? payload.clients : [],
            activeClientId: payload.activeClientId ?? null,
        };
        request.user = user;
        const required = this.reflector.getAllAndOverride(roles_decorator_1.ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (required && !required.includes(user.role)) {
            throw new common_1.ForbiddenException();
        }
        return true;
    }
};
exports.JwtAuthGuard = JwtAuthGuard;
exports.JwtAuthGuard = JwtAuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector])
], JwtAuthGuard);
//# sourceMappingURL=jwt-auth.guard.js.map