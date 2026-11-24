import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '~/modules/prisma/prisma.service';

export const DEFAULT_SAAS_PLANS = [
  {
    code: 'free',
    name: 'Miễn phí',
    description: 'Trải nghiệm lồng tiếng YouTube AI thời gian thực mỗi tháng',
    badge: null as string | null,
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'VND',
    monthlyMinutesLimit: 60 as number | null,
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
    description:
      'Dành cho người học ngoại ngữ, nghiên cứu và xem nội dung quốc tế mỗi ngày',
    badge: 'Phổ biến nhất' as string | null,
    priceMonthly: 99000,
    priceYearly: 950000,
    currency: 'VND',
    monthlyMinutesLimit: 600 as number | null,
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
    description:
      'Không gian làm việc chung cho đội nhóm, lớp học và doanh nghiệp',
    badge: 'Đội nhóm' as string | null,
    priceMonthly: 299000,
    priceYearly: 2890000,
    currency: 'VND',
    monthlyMinutesLimit: 3000 as number | null,
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

@Injectable()
export class SaasSeedService implements OnModuleInit {
  private readonly logger = new Logger(SaasSeedService.name);
  private seeded = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureDefaultPlans();
    } catch (error) {
      this.logger.warn(
        `Skipping startup default plan bootstrap: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async ensureDefaultPlans(): Promise<void> {
    if (this.seeded) return;
    const count = await this.prisma.plan.count();
    if (count > 0) {
      this.seeded = true;
      return;
    }

    for (const plan of DEFAULT_SAAS_PLANS) {
      await this.prisma.plan.upsert({
        where: { code: plan.code },
        create: plan,
        update: {},
      });
    }
    this.seeded = true;
    this.logger.log('Bootstrapped 3 default SaaS plans (free, pro, team)');
  }
}
