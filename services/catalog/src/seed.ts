import { newId, slugify, type Pool } from '@shopnow/platform';

const TREE: Record<string, string[]> = {
  'Thời trang nam': ['Áo thun', 'Áo sơ mi', 'Quần jean', 'Giày nam'],
  'Thời trang nữ': ['Váy đầm', 'Áo kiểu', 'Túi xách', 'Giày nữ'],
  'Điện thoại & Phụ kiện': ['Điện thoại', 'Tai nghe', 'Sạc dự phòng', 'Ốp lưng'],
  'Máy tính & Laptop': ['Laptop', 'Bàn phím', 'Chuột', 'Màn hình'],
  'Nhà cửa & Đời sống': ['Nhà bếp', 'Trang trí', 'Chăn ga gối'],
  'Sắc đẹp': ['Chăm sóc da', 'Trang điểm', 'Nước hoa'],
};

/** Danh mục mẫu cho môi trường mới — chỉ chạy khi bảng còn trống. */
export async function seedCategories(pool: Pool) {
  const { rows } = await pool.query('SELECT count(*)::int n FROM categories');
  if (rows[0].n > 0) return;
  let sort = 0;
  for (const [root, children] of Object.entries(TREE)) {
    const id = newId();
    await pool.query('INSERT INTO categories (id, name, slug, sort) VALUES ($1,$2,$3,$4)', [id, root, slugify(root), sort++]);
    let s = 0;
    for (const child of children) {
      await pool.query('INSERT INTO categories (id, parent_id, name, slug, sort) VALUES ($1,$2,$3,$4,$5)', [
        newId(), id, child, `${slugify(root)}-${slugify(child)}`, s++,
      ]);
    }
  }
}
