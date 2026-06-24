import {
  Injectable,
  NestMiddleware,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface TenantRequest extends Request {
  tenant?: {
    id: string;
    slug: string;
    plan: string;
  };
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
async use(req: TenantRequest, res: Response, next: NextFunction) {

  if (req.originalUrl === '/api/v1/tenants' && req.method === 'POST') {
    return next();
  }

  

  const slug = this.resolveSlug(req);

  if (!slug) {
    throw new BadRequestException(
      'Tenant not found. Pass X-Tenant-Slug header.',
    );
  }

    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, plan: true, status: true },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant "${slug}" does not exist.`);
    }

    if (tenant.status === 'SUSPENDED') {
      throw new BadRequestException('This account is suspended.');
    }

    req.tenant = { id: tenant.id, slug: tenant.slug, plan: tenant.plan };
    next();
  }

  private resolveSlug(req: Request): string | null {
    // Strategy 1: Header (API clients)
    const header = req.headers['x-tenant-slug'] as string;
    if (header) return header.toLowerCase().trim();

    const host = req.hostname;
    const parts = host.split('.');
    if (parts.length >= 3 && parts[0] !== 'www' && parts[0] !== 'api') {
      return parts[0].toLowerCase();
    }

    // Strategy 3: Query param (dev only)
    if (process.env.NODE_ENV !== 'production') {
      const query = req.query['tenant'] as string;
      if (query) return query.toLowerCase().trim();
    }

    return null;
  }
}
