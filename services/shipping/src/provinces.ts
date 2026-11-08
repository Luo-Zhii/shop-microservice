import { foldVietnamese } from '@shopnow/platform';

export type Region = 'NORTH' | 'CENTRAL' | 'SOUTH';

// 63 tỉnh/thành (phân chia hành chính trước sáp nhập 2025) theo 3 miền.
const PROVINCES: Record<Region, string[]> = {
  NORTH: [
    'Hà Nội', 'Hải Phòng', 'Hà Giang', 'Cao Bằng', 'Bắc Kạn', 'Tuyên Quang', 'Lào Cai', 'Điện Biên', 'Lai Châu', 'Sơn La',
    'Yên Bái', 'Hoà Bình', 'Thái Nguyên', 'Lạng Sơn', 'Quảng Ninh', 'Bắc Giang', 'Phú Thọ', 'Vĩnh Phúc', 'Bắc Ninh',
    'Hải Dương', 'Hưng Yên', 'Thái Bình', 'Hà Nam', 'Nam Định', 'Ninh Bình',
  ],
  CENTRAL: [
    'Thanh Hoá', 'Nghệ An', 'Hà Tĩnh', 'Quảng Bình', 'Quảng Trị', 'Thừa Thiên Huế', 'Đà Nẵng', 'Quảng Nam', 'Quảng Ngãi',
    'Bình Định', 'Phú Yên', 'Khánh Hoà', 'Ninh Thuận', 'Bình Thuận', 'Kon Tum', 'Gia Lai', 'Đắk Lắk', 'Đắk Nông', 'Lâm Đồng',
  ],
  SOUTH: [
    'Hồ Chí Minh', 'Bình Phước', 'Tây Ninh', 'Bình Dương', 'Đồng Nai', 'Bà Rịa - Vũng Tàu', 'Long An', 'Tiền Giang', 'Bến Tre',
    'Trà Vinh', 'Vĩnh Long', 'Đồng Tháp', 'An Giang', 'Kiên Giang', 'Cần Thơ', 'Hậu Giang', 'Sóc Trăng', 'Bạc Liêu', 'Cà Mau',
  ],
};

/** Tên viết tắt / cách gọi khác (đã chuẩn hoá) → tên chuẩn. */
const ALIASES: Record<string, string> = {
  hcm: 'Hồ Chí Minh', tphcm: 'Hồ Chí Minh', hochiminhcity: 'Hồ Chí Minh', saigon: 'Hồ Chí Minh', sg: 'Hồ Chí Minh',
  hn: 'Hà Nội', hanoi: 'Hà Nội', hp: 'Hải Phòng', dn: 'Đà Nẵng', ct: 'Cần Thơ',
  hue: 'Thừa Thiên Huế', thuathienhue: 'Thừa Thiên Huế',
  brvt: 'Bà Rịa - Vũng Tàu', vungtau: 'Bà Rịa - Vũng Tàu', bariavungtau: 'Bà Rịa - Vũng Tàu',
  daclac: 'Đắk Lắk', daklak: 'Đắk Lắk', dacnong: 'Đắk Nông', daknong: 'Đắk Nông', backan: 'Bắc Kạn', baccan: 'Bắc Kạn',
};

/** "TP. Hồ Chí Minh" / "Thành phố Hồ Chí Minh" / "tinh Dak Lak" → khoá so khớp "hochiminh" / "daklak". */
export function provinceKey(input: string): string {
  let s = foldVietnamese(input).toLowerCase().trim();
  s = s.replace(/^(thanh pho|tp\.?|t\.p\.?|tinh)\s*/, '');
  return s.replace(/[^a-z0-9]/g, '');
}

const INDEX = new Map<string, { name: string; region: Region }>();
for (const [region, names] of Object.entries(PROVINCES) as [Region, string[]][]) {
  for (const name of names) INDEX.set(provinceKey(name), { name, region });
}
for (const [alias, name] of Object.entries(ALIASES)) INDEX.set(alias, INDEX.get(provinceKey(name))!);

export function resolveProvince(input: string): { name: string; region: Region } | null {
  const k = provinceKey(input);
  return INDEX.get(k) ?? INDEX.get(k.replace(/^tp/, '')) ?? null;
}

export const ALL_PROVINCES = Object.values(PROVINCES).flat();
export const REGION_LABEL: Record<Region, string> = { NORTH: 'Miền Bắc', CENTRAL: 'Miền Trung', SOUTH: 'Miền Nam' };
