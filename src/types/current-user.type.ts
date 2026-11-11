import { User } from "$/prisma/browser";


export interface CurrentUserType extends User {
}

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends CurrentUserType { }
  }
}
