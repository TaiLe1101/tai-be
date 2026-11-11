import { User } from "$/prisma/browser";


export interface CurrentUserType extends Omit<User, 'password'> {
    permissions: string[];
}

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends CurrentUserType { }
  }
}
