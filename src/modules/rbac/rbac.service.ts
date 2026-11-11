import { Prisma, Role } from '$/prisma/browser';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_PERMISSIONS_METADATA } from '~/common/constants/permissions.constant';
import { PaginationQueryDTO } from '~/common/dto/pagination-query.dto';
import { BaseService } from '~/modules/base/base.service';
import { PrismaService } from '~/modules/prisma/prisma.service';
import { AssignPermissionDTO } from '~/modules/rbac/dto/assign-permission.dto';
import { CreateRoleDTO } from '~/modules/rbac/dto/create-role.dto';

@Injectable()
export class RBACService extends BaseService<Role, PaginationQueryDTO, Prisma.RoleCreateInput, Prisma.RoleUpdateInput> {
    constructor(private readonly prisma: PrismaService) {
        super(prisma.role)
    }

    protected override buildWhere(query: PaginationQueryDTO) {
        const where: Prisma.RoleWhereInput = {};

        if (query.q) {
            where.OR = [
                { name: { contains: query.q, mode: "insensitive" } }
            ];
        }

        return where;
    }

    override async findById(id: number) {
        const role = await this.prisma.role.findFirst({
            where: {
                id
            },
            include: {
                rolePermissions: {
                    include: {
                        permission: true
                    }
                }
            }
        })

        return role
    }

    override async create(data: CreateRoleDTO) {
        const result = await this.prisma.$transaction(async (tx) => {
            const createdRole = await tx.role.create({
                data: {
                    code: data.code,
                    name: data.name,
                    description: data.description,
                }
            });

            const dataRolePermissionIds = data.permissionIds.map(pid => ({ permissionId: pid, roleId: createdRole.id }));

            await tx.rolePermission.createMany({
                data: dataRolePermissionIds
            })

            if (data.userIds) {
                const dataUserRoleIds = data.userIds.map(uid => ({ userId: uid, roleId: createdRole.id }))
                await tx.userRole.createMany({
                    data: dataUserRoleIds
                })
            }

            const role = await tx.role.findFirst({
                where: { id: createdRole.id }
            });

            if (!role) throw new BadRequestException("Không thể tạo role hãy thử lại")

            return role;
        })

        return result;
    }

    async assignPermission(id: number, data: AssignPermissionDTO) {
        const result = await this.prisma.$transaction(async (tx) => {
            const role = await tx.role.findFirst({ where: { id } })
            if (!role) {
                throw new NotFoundException("Không tìm thấy vai trò")
            }
            await tx.rolePermission.deleteMany({
                where: {
                    roleId: id
                }
            })
            const newRolePermissions = data.permissionIds.map(pid => ({ permissionId: pid, roleId: id }))
            await tx.rolePermission.createMany({
                data: newRolePermissions
            })

            const roleAlter = await tx.role.findFirst({
                where: {
                    id
                },
                include: {
                    rolePermissions: {
                        include: {
                            permission: true
                        }
                    }
                }
            })

            return roleAlter
        })

        return result
    }

    async refreshPermissions() {
        const definedCodes = SYSTEM_PERMISSIONS_METADATA.map((p) => p.code);

        return await this.prisma.$transaction(async (tx) => {
            await tx.permission.updateMany({
                where: {
                    code: { notIn: definedCodes },
                    isActive: true,
                },
                data: {
                    isActive: false,
                    deletedAt: new Date(),
                },
            });

            // 2. Thêm mới hoặc cập nhật các quyền từ constant

            const existingPermissions = await tx.permission.findMany({
                where: { code: { in: definedCodes } }
            })
            const existingMap = new Map(existingPermissions.map((p) => [p.code, p]));

            // Phân loại: tạo mới vs cần cập nhật
            const toCreate: typeof SYSTEM_PERMISSIONS_METADATA = [];
            const codesToReactivate: string[] = [];

            for (const item of SYSTEM_PERMISSIONS_METADATA) {
                const existing = existingMap.get(item.code);
                if (!existing) {
                    toCreate.push(item);
                } else if (!existing.isActive || existing.deletedAt) {
                    // Nếu quyền đã có trong DB nhưng trước đó bị soft-delete -> cần kích hoạt lại
                    codesToReactivate.push(item.code);
                }
            }

            // 3. Batch Insert các quyền mới hoàn toàn (1 query duy nhất)
            if (toCreate.length > 0) {
                await tx.permission.createMany({
                    data: toCreate.map((item) => ({
                        code: item.code,
                        name: item.name,
                        description: item.description,
                        group: item.group,
                        isActive: true,
                    })),
                    skipDuplicates: true,
                });
            }

            // 4. Batch Re-activate các quyền cũ được đưa trở lại (1 query)
            if (codesToReactivate.length > 0) {
                await tx.permission.updateMany({
                    where: { code: { in: codesToReactivate } },
                    data: {
                        isActive: true,
                        deletedAt: null,
                    },
                });
            }

            // 5. Lấy danh sách kết quả (1 query)
            return await tx.permission.findMany({
                where: { isActive: true },
                orderBy: [{ group: 'asc' }, { code: 'asc' }],
            });
        });
    }

    async getPermissions() {
        const permissions = await this.prisma.permission.findMany({ where: { isActive: true }, orderBy: [{ group: "asc" }] })
        return permissions
    }
}
