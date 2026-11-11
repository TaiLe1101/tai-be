class BaseJwtPayload {
  ext!: number;
  iat!: number;
}

export class JwtPayload {
  sub!: {
    id: number;
  };
}

export class ResJwt extends BaseJwtPayload {
  sub!: {
    id: number;
  };
}
