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
exports.ErpNextClientService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../common/prisma/prisma.service");
const credentials_crypto_1 = require("./credentials.crypto");
let ErpNextClientService = class ErpNextClientService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async siteFor(clientId) {
        const site = await this.prisma.erpNextSite.findUnique({ where: { clientId } });
        if (!site || site.status !== 'active') {
            throw new common_1.NotFoundException('ERPNEXT_NOT_CONFIGURED');
        }
        return {
            site,
            apiKey: (0, credentials_crypto_1.decryptSecret)(site.apiKeyEncrypted),
            apiSecret: (0, credentials_crypto_1.decryptSecret)(site.apiSecretEncrypted),
        };
    }
    async healthCheck(clientId) {
        const { site, apiKey, apiSecret } = await this.siteFor(clientId);
        const checkedAt = new Date();
        try {
            const res = await fetch(`${site.siteUrl.replace(/\/$/, '')}/api/method/ping`, {
                headers: { Authorization: `token ${apiKey}:${apiSecret}` },
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok)
                throw new Error(`ERPNext responded ${res.status}`);
            await this.prisma.erpNextSite.update({
                where: { clientId },
                data: { lastHealthAt: checkedAt, lastHealthOk: true, healthError: null },
            });
            return { ok: true, siteUrl: site.siteUrl, checkedAt: checkedAt.toISOString() };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await this.prisma.erpNextSite.update({
                where: { clientId },
                data: { lastHealthAt: checkedAt, lastHealthOk: false, healthError: msg },
            });
            throw new common_1.ServiceUnavailableException({ message: 'ERPNEXT_UNREACHABLE', error: msg });
        }
    }
};
exports.ErpNextClientService = ErpNextClientService;
exports.ErpNextClientService = ErpNextClientService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ErpNextClientService);
//# sourceMappingURL=erpnext-client.service.js.map