import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantMiddleware } from './middleware/tenant.middleware';
import { TenantsModule } from './tenants/tenants.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TenantsModule,
    HealthModule,
    AuthModule,
    UsersModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantMiddleware)
      .exclude(
  { path: 'api/v1/health', method: RequestMethod.GET },
  { path: 'api/v1/tenants', method: RequestMethod.POST }
)
.forRoutes('*');
  }
}
