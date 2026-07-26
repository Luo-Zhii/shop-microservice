const axios = require('axios');

const products = [
  { name: "Áo len ren màu hồng cardigan nữ", price: 250000, description: "Áo len cardigan mỏng nhẹ, thiết kế ren điệu đà, phù hợp thời tiết se lạnh.", category: "Thời Trang Nữ" },
  { name: "Điện thoại Apple iPhone 15 Pro Max 256GB", price: 34990000, description: "iPhone 15 Pro Max với chip A17 Pro, camera 48MP và thiết kế titanium cao cấp.", category: "Điện Thoại & Phụ Kiện" },
  { name: "Nike Air Jordan 1 Mid Chicago Toe Like Auth", price: 850000, description: "Giày sneaker thể thao với phối màu Chicago cổ điển, dễ phối đồ.", category: "Giày Dép Nam" },
  { name: "MacBook Pro 14 inch M4 2024", price: 42990000, description: "MacBook Pro hiệu năng cao với vi xử lý M4 mới nhất, màn hình Liquid Retina XDR.", category: "Máy Tính & Laptop" },
  { name: "Gel Rửa Mặt Emmié Soothing", price: 180000, description: "Sữa rửa mặt dạng gel dịu nhẹ, cân bằng độ pH, an toàn cho da nhạy cảm.", category: "Sắc Đẹp" },
  { name: "Quần Tập Gym Nữ Cạp Chéo", price: 150000, description: "Quần legging tập gym tôn dáng, co giãn 4 chiều, thiết kế cạp chéo quyến rũ.", category: "Thời Trang Nữ" },
  { name: "Dép đi trong nhà siêu xinh nam nữ", price: 35000, description: "Dép bông đi trong nhà êm ái, giữ ấm chân, đế chống trơn trượt hiệu quả.", category: "Nhà Cửa & Đời Sống" },
  { name: "Máy giặt Electrolux Inverter 11 kg", price: 9500000, description: "Máy giặt lồng ngang với công nghệ Inverter tiết kiệm điện, giặt sạch sâu.", category: "Thiết Bị Điện Tử" }
];

async function seed() {
  for (const product of products) {
    try {
      await axios.post('http://localhost:5861/api/product', product);
      console.log(`Added: ${product.name}`);
    } catch (e) {
      console.error(`Failed to add ${product.name}: ${e.message}`);
    }
  }
}

seed();
