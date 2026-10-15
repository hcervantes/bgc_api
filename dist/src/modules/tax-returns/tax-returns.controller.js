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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaxReturnsController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../common/auth/jwt-auth.guard");
const tenant_guard_1 = require("../../common/tenancy/tenant.guard");
const roles_decorator_1 = require("../../common/auth/roles.decorator");
const current_user_decorator_1 = require("../../common/auth/current-user.decorator");
const tax_returns_service_1 = require("./tax-returns.service");
const presign_upload_dto_1 = require("./dto/presign-upload.dto");
let TaxReturnsController = class TaxReturnsController {
    service;
    constructor(service) {
        this.service = service;
    }
    presign(req, body, user) {
        return this.service.presignUpload({
            tenant: req.tenant,
            taxYear: body.taxYear,
            type: body.type,
            originalFilename: body.originalFilename,
            preparedByUserId: user.sub,
        });
    }
    finalize(req, id) {
        return this.service.finalize(req.tenant, id);
    }
    list(req, taxYear) {
        return this.service.list(req.tenant, taxYear ? Number(taxYear) : undefined);
    }
    download(req, id, user) {
        return this.service.download(req.tenant, id, user.sub, req.ip ?? null);
    }
};
exports.TaxReturnsController = TaxReturnsController;
__decorate([
    (0, common_1.Post)('presign-upload'),
    (0, roles_decorator_1.Roles)('STAFF', 'ADMIN'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, presign_upload_dto_1.PresignUploadDto, Object]),
    __metadata("design:returntype", void 0)
], TaxReturnsController.prototype, "presign", null);
__decorate([
    (0, common_1.Post)(':id/finalize'),
    (0, roles_decorator_1.Roles)('STAFF', 'ADMIN'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], TaxReturnsController.prototype, "finalize", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Query)('taxYear')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], TaxReturnsController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(':id/download'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], TaxReturnsController.prototype, "download", null);
exports.TaxReturnsController = TaxReturnsController = __decorate([
    (0, common_1.Controller)('clients/:clientId/tax-returns'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [tax_returns_service_1.TaxReturnsService])
], TaxReturnsController);
//# sourceMappingURL=tax-returns.controller.js.map