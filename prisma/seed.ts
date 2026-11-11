import { PrismaClient } from '$/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import 'dotenv/config';

const adapter = new PrismaPg({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const prisma = new PrismaClient({ adapter });


async function main() {
  //#region Tạo giới tính mặc định
  console.log("🕐 Đang tạo giới tính mặc định")

  const male = await prisma.gender.upsert(
    {
      where: {
        code: "MALE"
      },
      create: {
        code: "MALE",
        name: "Nam"
      },
      update: {
        code: "MALE",
        name: "Nam"
      }
    },
  );

  await prisma.gender.upsert({
    where: {
      code: "FIMALE",
    },
    create: {
      code: "FIMALE",
      name: "Nữ"
    },
    update: {
      code: "FIMALE",
      name: "Nữ"
    }
  })

  console.log("✅ Tạo thành công giới tính mặc định");
  //#endregion

  //#region Tạo tài khoản root
  console.log("🕐 Đang tạo tài khoản System Admin")

  await prisma.user.upsert({
    where: {
      username: "root"
    },
    create: {
      username: "root",
      password: "$2a$10$ksNXc7Y6q9Oj025nWyIB7eLeVIKYbSb5n216Y3ioLgTAu6gMTY/ny",
      firstName: "Admin",
      lastName: "System",
      genderId: male.id,
      isRoot: true,
    },
    update: {
      username: "root",
      password: "$2a$10$ksNXc7Y6q9Oj025nWyIB7eLeVIKYbSb5n216Y3ioLgTAu6gMTY/ny",
      firstName: "Admin",
      lastName: "System",
      genderId: male.id,
      isRoot: true,
    },
  });

  console.log("✅ Tạo thành công System Admin");
  //#endregion

  //#region Tạo các vị trí vai trò mặc định
  await prisma.position.upsert({
    where: {
      code: "CEO",
    },
    create: {
      code: "CEO",
      name: "Giám đốc điều hành",
    },
    update: {
      code: "CEO",
      name: "Giám đốc điều hành",
    },
  })
  //#endregion
}

main()
  .catch((e) => {
    console.error('❌ Lỗi khi chạy seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
