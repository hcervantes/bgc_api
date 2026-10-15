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
exports.DocumentsController = void 0;
const common_1 = require("@nestjs/common");
const jwt_auth_guard_1 = require("../../common/auth/jwt-auth.guard");
const tenant_guard_1 = require("../../common/tenancy/tenant.guard");
const current_user_decorator_1 = require("../../common/auth/current-user.decorator");
const presign_upload_dto_1 = require("./presign-upload.dto");
const documents_service_1 = require("./documents.service");
let DocumentsController = class DocumentsController {
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
            uploadedByUserId: user.sub,
        });
    }
};
exports.DocumentsController = DocumentsController;
__decorate([
    (0, common_1.Post)('presign-upload'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, presign_upload_dto_1.PresignUploadDto, Object]),
    __metadata("design:returntype", void 0)
], DocumentsController.prototype, "presign", null);
exports.DocumentsController = DocumentsController = __decorate([
    (0, common_1.Controller)('clients/:clientId/documents'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard, tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [documents_service_1.DocumentsService])
], DocumentsController);
//# sourceMappingURL=documents.controller.js.map