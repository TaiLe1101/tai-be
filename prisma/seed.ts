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
      isRoot: true,
    },
    update: {
      username: "root",
      password: "$2a$10$ksNXc7Y6q9Oj025nWyIB7eLeVIKYbSb5n216Y3ioLgTAu6gMTY/ny",
      firstName: "Admin",
      lastName: "System",
      isRoot: true,
    },
  });

  console.log("✅ Tạo thành công System Admin");
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
