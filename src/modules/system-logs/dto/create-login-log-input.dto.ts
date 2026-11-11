import { LoginStatus } from "$/prisma/enums";

export class CreateLoginLogInputDTO {
    username?: string | null;
    ipAddress: string;
    userAgent?: string | null;
    device?: string | null;
    status: LoginStatus;
    failureReason?: string | null;
}