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
exports.TaxReturnsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../common/prisma/prisma.service");
let TaxReturnsService = class TaxReturnsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async presignUpload(input) {
        const storageKey = [
            input.tenant.slug,
            'returns',
            input.taxYear,
            `${crypto.randomUUID()}-${input.originalFilename.replace(/[^\w.\-]/g, '_')}`,
        ].join('/');
        const record = await this.prisma.taxReturn.create({
            data: {
                clientId: input.tenant.clientId,
                taxYear: input.taxYear,
                type: input.type,
                storageKey,
                originalFilename: input.originalFilename,
                preparedByUserId: input.preparedByUserId,
            },
        });
        return { id: record.id, storageKey, uploadUrl: null };
    }
    async finalize(tenant, id) {
        const updated = await this.prisma.taxReturn.updateMany({
            where: { id, clientId: tenant.clientId, finalizedAt: null },
            data: { finalizedAt: new Date() },
        });
        if (updated.count === 0)
            throw new common_1.NotFoundException();
        return { id, finalized: true };
    }
    async list(tenant, taxYear) {
        return this.prisma.taxReturn.findMany({
            where: { clientId: tenant.clientId, ...(taxYear ? { taxYear } : {}) },
            orderBy: [{ taxYear: 'desc' }, { createdAt: 'desc' }],
        });
    }
    async download(tenant, id, userId, ip) {
        const record = await this.prisma.taxReturn.findFirst({
            where: { id, clientId: tenant.clientId },
        });
        if (!record)
            throw new common_1.NotFoundException();
        await this.prisma.auditLog.create({
            data: { userId, clientId: tenant.clientId, action: 'tax_return.download', targetId: id, ip },
        });
        return { id, storageKey: record.storageKey, downloadUrl: null };
    }
};
exports.TaxReturnsService = TaxReturnsService;
exports.TaxReturnsService = TaxReturnsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TaxReturnsService);
//# sourceMappingURL=tax-returns.service.js.map