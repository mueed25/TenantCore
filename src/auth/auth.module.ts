import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersModule } from 'src/users/users.module';
import { UsersService } from 'src/users/users.service';

@Module({
  exports: [UsersService],
  providers: [AuthService]

})
export class AuthModule {}
