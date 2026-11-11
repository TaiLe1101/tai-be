import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

// Kích hoạt plugin 1 lần duy nhất cho toàn bộ app
dayjs.extend(utc);
dayjs.extend(timezone);

export const appDayJs = {
  /**
   * Tạo instance Dayjs theo giờ UTC hiện tại hoặc từ input
   */
  utc: (date?: string | number | Date | Dayjs) => dayjs.utc(date),

  /**
   * Lấy mốc thời gian bắt đầu ngày theo UTC (00:00:00.000Z)
   */
  startOfDayUtc: (date?: string | number | Date | Dayjs): Date => {
    return dayjs.utc(date).startOf('day').toDate();
  },

  /**
   * Lấy mốc thời gian kết thúc ngày theo UTC (23:59:59.999Z)
   */
  endOfDayUtc: (date?: string | number | Date | Dayjs): Date => {
    return dayjs.utc(date).endOf('day').toDate();
  },

  /**
   * Lấy chuỗi định dạng YYYY-MM-DD theo UTC
   */
  formatDateUtc: (date?: string | number | Date | Dayjs): string => {
    return dayjs.utc(date).format('YYYY-MM-DD');
  },

  /**
   * Lấy Date object thời điểm hiện tại chuẩn UTC để ghi vào DB
   */
  nowUtcDate: (): Date => {
    return dayjs.utc().toDate();
  },

  /**
   * Lấy chuỗi ISO 8601 chuẩn UTC (ví dụ: 2026-09-17T07:11:14.000Z) trả về cho Client
   */
  toISOString: (date?: string | number | Date | Dayjs): string => {
    return dayjs.utc(date).toISOString();
  },

  /**
   * Instance gốc nếu cần gọi các phương thức linh hoạt khác của dayjs
   */
  core: dayjs,
};

export { Dayjs };
