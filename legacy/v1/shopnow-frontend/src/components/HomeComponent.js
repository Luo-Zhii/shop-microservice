import React, { useState, useEffect } from "react";
import "bootstrap/dist/css/bootstrap.min.css";
import { Container, Box, Typography, IconButton, Grid, Button, Chip } from "@mui/material";
import { ShoppingCartRounded, LocalShipping, Discount, Language, Star } from "@mui/icons-material";
import { Carousel } from "react-bootstrap";
import productService from "../services/ProductService";
import cartService from "../services/CartService";
import { toast } from 'react-toastify';
import { Card } from "react-bootstrap";
import 'react-toastify/dist/ReactToastify.css';

const categories = [
  { name: "Thời Trang Nam", image: "/thoi-trang-nam.png" },
  { name: "Điện Thoại & Phụ Kiện", image: "/dien-thoai-phu-kien.png" },
  { name: "Thiết Bị Điện Tử", image: "/thiet-bi-dien-tu.png" },
  { name: "Máy Tính & Laptop", image: "/may-tinh-lap-top.png" },
  { name: "Nhà Cửa & Đời Sống", image: "/nha-cua-doi-song.png" },
  { name: "Sắc Đẹp", image: "/sac-dep.png" },
  { name: "Đồng Hồ", image: "/dong-ho.png" },
  { name: "Giày Dép Nam", image: "/giay-dep-nam.png" },
  { name: "Mẹ & Bé", image: "/me-va-be.png" },
];

const features = [
  { icon: <Star />, label: "Hàng Chính Hãng" },
  { icon: <Discount />, label: "Giá Tốt Nhất" },
  { icon: <LocalShipping />, label: "Miễn Phí Ship" },
  { icon: <Language />, label: "Toàn Quốc" },
];

export default function Home() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const itemsPerPage = 6;
  const [featuredProducts, setFeaturedProducts] = useState([]);
  const [cartId, setCartId] = useState(null);
  const [currentProduct, setCurrentProduct] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);

  useEffect(() => {
    const user = localStorage.getItem("user");
    if (user) {
      const parsedUser = JSON.parse(user);
      setIsAdmin(parsedUser.username === "admin");
    }
  }, []);

  useEffect(() => {
    retrieveProducts();
    retrieveCart();
  }, []);

  const handleNext = () => {
    if (currentIndex + itemsPerPage < categories.length) {
      setCurrentIndex(currentIndex + itemsPerPage);
    }
  };

  const handlePrev = () => {
    if (currentIndex - itemsPerPage >= 0) {
      setCurrentIndex(currentIndex - itemsPerPage);
    }
  };

  const retrieveProducts = () => {
    productService.getAll()
      .then((response) => setFeaturedProducts(response.data))
      .catch((e) => console.log(e));
  };

  const retrieveCart = async () => {
    const user = localStorage.getItem("user");
    if (!user) return;
    const parsedUser = JSON.parse(user);
    try {
      const response = await cartService.getByName(parsedUser.username);
      setCartId(response.data.id);
    } catch (e) {
      cartService.create(parsedUser.username)
        .then((response) => setCartId(response.data.id))
        .catch((e) => console.log(e));
    }
  };

  const addToCart = (product) => {
    cartService.addProducts(cartId, [product])
      .then(() => toast.success(`${product.name} added to cart`))
      .catch((e) => console.log(e));
  };

  const formatCurrency = (amount) => {
    const number = Number(amount) || 0;
    return number.toLocaleString("vi-VN");
  };

  const productImageMap = {
    "Áo len ren màu hồng cardigan nữ": "ao-len-nu.png",
    "Điện thoại Apple iPhone 15 Pro Max 256GB": "iphone-15-promax.png",
    "Nike Air Jordan 1 Mid Chicago Toe Like Auth": "giay-nike-air.png",
    "MacBook Pro 14 inch M4 2024": "macbook-m4-pro.png",
    "Gel Rửa Mặt Emmié Soothing": "sua-rua-mat.png",
    "Quần Tập Gym Nữ Cạp Chéo": "quan-tap-gym-nu.png",
    "Dép đi trong nhà siêu xinh nam nữ": "dep-di-trong-nha.png",
    "Máy giặt Electrolux Inverter 11 kg": "may-giat.png",
  };

  const displayedCategories = categories.slice(currentIndex, currentIndex + itemsPerPage);

  const filteredProducts = selectedCategory
    ? featuredProducts.filter(p => p.category === selectedCategory)
    : featuredProducts;

  return (
    <Container maxWidth="lg">
      {/* Banner */}
      <Box sx={{ mb: 4, borderRadius: 3, overflow: 'hidden', boxShadow: 3 }}>
        <Carousel>
          {["slide-4.png", "slide-0.png", "slide-1.png", "slide-2.png", "slide-3.png"].map((slide, i) => (
            <Carousel.Item key={i}>
              <img className="d-block w-100" src={slide} alt={`Slide ${i}`} style={{ maxHeight: 380, objectFit: 'cover' }} />
            </Carousel.Item>
          ))}
        </Carousel>
      </Box>

      {/* Feature Icons */}
      <Grid container spacing={3} justifyContent="center" sx={{ mb: 5 }}>
        {features.map((f, i) => (
          <Grid item xs={6} sm={3} key={i} textAlign="center">
            <Box sx={{
              p: 2, borderRadius: 3, bgcolor: '#f5f3ff',
              transition: 'all 0.3s',
              '&:hover': { bgcolor: '#ede9fe', transform: 'translateY(-2px)' }
            }}>
              <Box sx={{ color: '#6366f1', mb: 0.5 }}>{f.icon}</Box>
              <Typography variant="body2" fontWeight={600} color="#1e1b4b">{f.label}</Typography>
            </Box>
          </Grid>
        ))}
      </Grid>

      {/* Categories */}
      <Typography variant="h5" fontWeight={700} mb={3} align="center" color="#1e1b4b">
        DANH MỤC NỔI BẬT
      </Typography>

      <Box display="flex" alignItems="center" justifyContent="center" gap={1} mb={4}>
        <IconButton onClick={handlePrev} disabled={currentIndex === 0}
          sx={{ bgcolor: '#f5f3ff', '&:hover': { bgcolor: '#ede9fe' } }}>‹</IconButton>
        <Grid container spacing={2} justifyContent="center">
          {displayedCategories.map((cat, i) => (
            <Grid item xs={6} sm={4} md={1.3} key={i} textAlign="center"
              onClick={() => setSelectedCategory(selectedCategory === cat.name ? null : cat.name)}
              sx={{ cursor: 'pointer' }}>
              <Box sx={{
                borderRadius: '50%', overflow: 'hidden', width: 80, height: 80,
                mx: 'auto', mb: 1, border: selectedCategory === cat.name ? '3px solid #6366f1' : '3px solid transparent',
                transition: 'all 0.3s', boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
              }}>
                <img src={cat.image} alt={cat.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </Box>
              <Typography variant="caption" fontWeight={selectedCategory === cat.name ? 700 : 400}
                color={selectedCategory === cat.name ? '#6366f1' : '#374151'} fontSize={11}>
                {cat.name}
              </Typography>
            </Grid>
          ))}
        </Grid>
        <IconButton onClick={handleNext} disabled={currentIndex + itemsPerPage >= categories.length}
          sx={{ bgcolor: '#f5f3ff', '&:hover': { bgcolor: '#ede9fe' } }}>›</IconButton>
      </Box>

      {selectedCategory && (
        <Box textAlign="center" mb={2}>
          <Chip label={`Xóa bộ lọc: ${selectedCategory}`} onDelete={() => setSelectedCategory(null)}
            sx={{ bgcolor: '#ede9fe', color: '#6366f1', fontWeight: 500 }} />
        </Box>
      )}

      {/* Products Grid */}
      <Typography variant="h5" fontWeight={700} mb={3} mt={2} align="center" color="#1e1b4b">
        {selectedCategory ? selectedCategory.toUpperCase() : 'SẢN PHẨM NỔI BẬT'}
      </Typography>
      <div className="row row-cols-1 row-cols-sm-2 row-cols-md-4 g-4">
        {filteredProducts.map((product, index) => (
          <div key={index} className="col">
            <Card className="product-card h-100">
              <div style={{ overflow: 'hidden' }}>
                <Card.Img variant="top" src={`/${productImageMap[product.name] || "placeholder.png"}`} />
              </div>
              <Card.Body className="d-flex flex-column">
                <Card.Title style={{ fontSize: 14, fontWeight: 600, color: '#1e1b4b', lineHeight: 1.4 }}>
                  {product.name}
                </Card.Title>
                <Card.Subtitle className="mb-2" style={{ fontSize: 12, color: '#9ca3af' }}>
                  {product.category}
                </Card.Subtitle>
                <Card.Text style={{ fontSize: 12, color: '#6b7280', flex: 1 }}>
                  {product.description?.length > 60
                    ? product.description.substring(0, 60) + "..."
                    : product.description}
                </Card.Text>
                <Card.Text style={{ fontSize: 16, fontWeight: 700, color: '#6366f1' }}>
                  {formatCurrency(product.price)}₫
                </Card.Text>
                <Button startIcon={<ShoppingCartRounded />} variant="outlined" size="small"
                  onClick={() => addToCart(product)}
                  sx={{
                    color: '#6366f1', borderColor: '#6366f1', borderRadius: 2,
                    textTransform: 'none', fontWeight: 500,
                    '&:hover': { bgcolor: '#6366f1', color: '#fff', borderColor: '#6366f1' }
                  }}>
                  Thêm vào giỏ
                </Button>
              </Card.Body>
            </Card>
          </div>
        ))}
      </div>
      {filteredProducts.length === 0 && (
        <Box textAlign="center" py={6}>
          <Typography color="text.secondary">Không có sản phẩm nào.</Typography>
        </Box>
      )}
    </Container>
  );
}
