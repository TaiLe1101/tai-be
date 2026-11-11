import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { PaginationQueryDTO } from '~/common/dto/pagination-query.dto';
import { PaginationType } from '~/types/pagination.type';

export interface PrismaModelDelegate {
    findMany(args: any): Promise<any[]>;
    count(args: any): Promise<number>;
    findUnique(args: any): Promise<any>;
    create(args: any): Promise<any>;
    update(args: any): Promise<any>;
    delete(args: any): Promise<any>;
}

@Injectable()
export abstract class BaseService<
    TModel,
    TQuery extends PaginationQueryDTO,
    TCreateDto,
    TUpdateDto,
> {
    constructor(protected readonly model: PrismaModelDelegate) { }

    protected buildWhere(query: TQuery): Record<string, any> {
        return {};
    }

    async findAll(query: TQuery) {
        const page = Math.max(Number(query.page) || 1, 1);
        const limit = Math.max(Number(query.limit) || 10, 1);
        const skip = (page - 1) * limit;

        const where = this.buildWhere(query);
        const orderBy = query.sortBy
            ? { [query.sortBy]: query.sortOrder || 'desc' }
            : { createdAt: 'desc' };

        const [items, total] = await Promise.all([
            this.model.findMany({
                where,
                skip,
                take: limit,
                orderBy,
            }),
            this.model.count({ where }),
        ]);
        const { page: _, limit: __, ...metaOthers } = query;
        return {
            data: items as TModel[],
            pagination: {
                totalItems: total,
                page,
                limit,
                totalPage: Math.ceil(total / limit),
            },
            meta: {
                ...metaOthers
            },
        };
    }

    async findLookup(query?: Partial<TQuery>) {
        const where = query ? this.buildWhere(query as TQuery) : {};
        return this.model.findMany({ where }) as Promise<TModel[]>;
    }

    async findById(id: number): Promise<TModel | null> {
        return this.model.findUnique({ where: { id } });
    }

    async create(data: TCreateDto): Promise<TModel> {
        return this.model.create({ data });
    }

    async update(id: number, data: TUpdateDto): Promise<TModel> {
        const existing = await this.findById(id);
        if (!existing) throw new NotFoundException("Không tồn tại!")
        return this.model.update({ where: { id }, data });
    }

    async delete(id: number): Promise<TModel> {
        const existing = await this.findById(id);
        if (!existing) throw new NotFoundException("Không tồn tại!")
        return this.model.delete({ where: { id } });
    }
}
