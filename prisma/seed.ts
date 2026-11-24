import { PrismaClient } from '$/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
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

  //#region Tạo 3 gói SaaS mặc định
  console.log("🕐 Đang khởi tạo các gói SaaS mặc định");
  const defaultPlans = [
    {
      code: 'free',
      name: 'Miễn phí',
      description: 'Trải nghiệm lồng tiếng YouTube AI thời gian thực mỗi tháng',
      badge: null,
      priceMonthly: 0,
      priceYearly: 0,
      currency: 'VND',
      monthlyMinutesLimit: 60,
      maxSeats: 1,
      features: [
        '60 phút lồng tiếng AI mỗi tháng',
        '42 ngôn ngữ & giọng đọc Neural TTS',
        'Phụ đề song ngữ nổi trực tiếp trên YouTube',
        'Đồng bộ âm thanh – video & Ducking 4 chế độ',
        '1 thành viên (tài khoản cá nhân)',
      ],
      isPublic: true,
      isDefault: true,
      isHighlighted: false,
      sortOrder: 1,
      isActive: true,
    },
    {
      code: 'pro',
      name: 'Pro',
      description: 'Dành cho người học ngoại ngữ, nghiên cứu và xem nội dung quốc tế mỗi ngày',
      badge: 'Phổ biến nhất',
      priceMonthly: 99000,
      priceYearly: 950000,
      currency: 'VND',
      monthlyMinutesLimit: 600,
      maxSeats: 1,
      features: [
        '600 phút lồng tiếng AI mỗi tháng (10 giờ)',
        'Dịch phân đoạn ~45s + tải trước 30s mượt mà',
        '42 ngôn ngữ & đầy đủ giọng Neural TTS',
        'Phụ đề song ngữ kéo thả & Transcript tua nhanh',
        'Hỗ trợ ưu tiên qua Zalo / Email',
      ],
      isPublic: true,
      isDefault: false,
      isHighlighted: true,
      sortOrder: 2,
      isActive: true,
    },
    {
      code: 'team',
      name: 'Team',
      description: 'Không gian làm việc chung cho đội nhóm, lớp học và doanh nghiệp',
      badge: 'Đội nhóm',
      priceMonthly: 299000,
      priceYearly: 2890000,
      currency: 'VND',
      monthlyMinutesLimit: 3000,
      maxSeats: 5,
      features: [
        '3.000 phút lồng tiếng AI mỗi tháng (50 giờ)',
        'Tối đa 5 thành viên dùng chung hạn mức Tenant',
        'Quản lý thành viên & phân quyền Owner / Admin / Member',
        'Toàn bộ tính năng Pro & đồng bộ 3-cue lookahead',
        'Hỗ trợ kỹ thuật trực tiếp & nâng cấp linh hoạt',
      ],
      isPublic: true,
      isDefault: false,
      isHighlighted: false,
      sortOrder: 3,
      isActive: true,
    },
  ];

  for (const plan of defaultPlans) {
    await prisma.plan.upsert({
      where: { code: plan.code },
      create: plan,
      update: {},
    });
  }
  console.log("✅ Khởi tạo thành công 3 gói SaaS mặc định (free, pro, team)");
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
