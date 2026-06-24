import { Body, Controller, Post, Req } from "@nestjs/common";
import { TenantRequest } from "src/middleware/tenant.middleware";
import { LoginDto } from "./dto/login.dto";

@Controller()
export class AuthController {

    @Post('login')
    async login(@Req() req: TenantRequest, @Body() dto: LoginDto) {
        return { req, dto };
    }
}