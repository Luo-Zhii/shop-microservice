const { Client } = require('pg');

// Kết nối trực tiếp vào PostgreSQL thông qua port-forward ở localhost
const client = new Client({
  host: 'localhost',
  port: 5433,
  database: 'postgres',
  user: 'shop_admin',
  password: '123456',
});

const products = [
  { name: "Áo len ren màu hồng cardigan nữ", price: 200000, description: "Áo len thời trang nữ", category: "fashion" },
  { name: "Điện thoại Apple iPhone 15 Pro Max 256GB", price: 29990000, description: "Điện thoại cao cấp", category: "electronics" },
  { name: "Nike Air Jordan 1 Mid Chicago Toe Like Auth", price: 3500000, description: "Giày thể thao", category: "shoes" },
  { name: "MacBook Pro 14 inch M4 2024", price: 39990000, description: "Laptop hiệu năng cao", category: "electronics" },
  { name: "Gel Rửa Mặt Emmié Soothing", price: 220000, description: "Mỹ phẩm chăm sóc da", category: "beauty" },
  { name: "Quần Tập Gym Nữ Cạp Chéo", price: 150000, description: "Đồ tập thể thao", category: "sports" },
  { name: "Dép đi trong nhà siêu xinh nam nữ", price: 35000, description: "Đồ gia dụng tiện ích", category: "home" },
  { name: "Máy giặt Electrolux Inverter 11 kg", price: 9500000, description: "Thiết bị điện gia dụng", category: "home" }
];

async function seedDirectly() {
  try {
    console.log('Connecting directly to PostgreSQL inside K8s...');
    await client.connect();
    console.log('Database connected successfully!\n');

    for (const p of products) {
      try {
        await client.query(
          'INSERT INTO product (name, price, description, category) VALUES ($1, $2, $3, $4)',
          [p.name, p.price, p.description, p.category]
        );
        console.log(`Successfully inserted into DB: ${p.name}`);
      } catch (err) {
        console.error(`Failed to insert ${p.name}: ${err.message}`);
      }
    }

    console.log('\nAll products seeded successfully via direct database connection!');
  } catch (error) {
    console.error('Database connection failed:', error.message);
  } finally {
    await client.end();
  }
}

seedDirectly();