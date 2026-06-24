import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';


const prisma = new PrismaClient();

@Injectable()
export class UsersService {

    async findOne( email: string, tenantId: string) {
       const user = await prisma.tenantUser.findUnique({ where: { tenantId_email: { email, tenantId } } });
       return user;
    }
}
