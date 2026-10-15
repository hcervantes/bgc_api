"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const helmet_1 = __importDefault(require("helmet"));
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    const config = app.get(config_1.ConfigService);
    app.setGlobalPrefix('v1');
    app.use((0, helmet_1.default)());
    if (config.get('NODE_ENV') !== 'development') {
        app.getHttpAdapter().getInstance().set('trust proxy', 1);
    }
    app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.enableShutdownHooks();
    await app.listen(config.get('PORT') ?? 4000);
    console.log(`BGC API listening on :${config.get('PORT') ?? 4000}/v1`);
}
bootstrap();
//# sourceMappingURL=main.js.map