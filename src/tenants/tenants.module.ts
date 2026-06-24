import { Module, Controller, Get, Post, Body, Param, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { IsString, IsOptional } from 'class-validator';

const prisma = new PrismaClient();

export class CreateTenantDto {
  @IsString() name: string;
  @IsString() slug: string;
  @IsOptional() @IsString() plan?: string;
}

@Controller('tenants')
export class TenantsController {
  @Post()
  async create(@Body() dto: CreateTenantDto) {
    const existing = await prisma.tenant.findUnique({ where: { slug: dto.slug} });

    if (existing) {
      throw new BadRequestException(`Tenant with slug "${dto.slug}" already exists.`);
    }
    return prisma.tenant.create({
      data: { name: dto.name, slug: dto.slug.toLowerCase() },
    });
  }

  @Get(':slug')
  async findOne(@Param('slug') slug: string) {
    return prisma.tenant.findUnique({ where: { slug } });
  }

  @Get(':slug/users')
  async getUsers(@Param('slug') slug: string) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      include: { users: true },
    });
    return tenant?.users || [];
  }
}

@Module({ controllers: [TenantsController] })
export class TenantsModule {}
