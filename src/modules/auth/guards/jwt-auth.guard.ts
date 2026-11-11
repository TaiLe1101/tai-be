import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '~/common/decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    public constructor(private readonly reflector: Reflector) {
        super();
    }

    public override canActivate(context: ExecutionContext) {
        if (
            this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
                context.getHandler(),
                context.getClass(),
            ])
        ) {
            return true;
        }

        return super.canActivate(context)
    }
}
