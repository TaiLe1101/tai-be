import { ClassConstructor, plainToInstance } from 'class-transformer';

export class Mapper {
  static toDto<T, V>(dto: ClassConstructor<T>, data: V): T {
    return plainToInstance(dto, data, {
      excludeExtraneousValues: true,
    });
  }

  static toDtos<T, V>(dto: ClassConstructor<T>, data: V[]): T[] {
    return plainToInstance(dto, data, {
      excludeExtraneousValues: true,
    });
  }
}
