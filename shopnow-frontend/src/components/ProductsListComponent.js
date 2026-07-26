import React, { useState, useEffect } from "react";
import productService from "../services/ProductService";
import { Link } from "react-router-dom";
import { connect } from "react-redux";
import { withRouter } from '../common/WithRouter';
import { updateProduct } from "../actions/products";
import { Card, Modal } from "react-bootstrap";
import cartService from "../services/CartService";
import DeleteIcon from '@mui/icons-material/Delete';
import Button from '@mui/material/Button';
import { Add, Inventory2Sharp, ShoppingCartRounded } from "@mui/icons-material";
import { Box, Typography, Chip } from "@mui/material";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const ProductsList = () => {
  const [products, setProducts] = useState([]);
  const [cartProducts, setCartProducts] = useState([]);
  const [currentProduct, setCurrentProduct] = useState(null);
  const [totalPrice, setTotalPrice] = useState("");
  const [cartId, setCartId] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const user = localStorage.getItem("user");
    if (user) {
      const parsedUser = JSON.parse(user);
      setIsAdmin(parsedUser.username === "admin");
    }
    retrieveProducts();
    retrieveCart();
  }, []);

  const retrieveCart = async () => {
    const user = localStorage.getItem("user");
    if (!user) return;
    const parsedUser = JSON.parse(user);
    try {
      const response = await cartService.getByName(parsedUser.username);
      setCartId(response.data.id);
      setCartProducts(response.data.products);
      getTotalPrice(response.data.id);
    } catch (e) {
      cartService.create(parsedUser.username)
        .then((response) => setCartId(response.data.id))
        .catch((e) => console.log(e));
    }
  };

  const retrieveProducts = () => {
    productService.getAll()
      .then((response) => setProducts(response.data))
      .catch((e) => console.log(e));
  };

  const refreshList = () => {
    retrieveCart();
    retrieveProducts();
    setCurrentProduct(null);
  };

  const setActiveProduct = (product, index) => {
    setCurrentProduct(product);
    setShowModal(true);
  };

  const deleteAllProducts = () => {
    if (!window.confirm("Are you sure you want to delete all products?")) return;
    productService.deleteAll()
      .then(() => { refreshList(); toast.success("All products deleted"); })
      .catch((e) => console.log(e));
  };

  const deleteProduct = (product) => {
    productService.delete(product.id)
      .then(() => { refreshList(); toast.success(product.name + " deleted"); })
      .catch((e) => console.log(e));
    setShowModal(false);
  };

  const addToCart = (product) => {
    cartService.addProducts(cartId, [product])
      .then((response) => {
        setCartProducts(response.data.products);
        getTotalPrice(cartId);
        toast.success(product.name + " added to cart");
      })
      .catch((e) => console.log(e));
    setShowModal(false);
  };

  const removeProductFromCart = (product) => {
    cartService.deleteProduct(cartId, product.id)
      .then((response) => {
        setCartProducts(response.data.products);
        getTotalPrice(cartId);
      })
      .catch((e) => console.log(e));
  };

  const getTotalPrice = (cartId) => {
    cartService.getTotalPrice(cartId)
      .then((response) => setTotalPrice(response.data.total_price))
      .catch((e) => console.log(e));
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

  const formatCurrency = (amount) => {
    const number = Number(amount) || 0;
    return number.toLocaleString("vi-VN");
  };

  return (
    <div className="row">
      {/* Product Detail Modal */}
      <Modal show={showModal} onHide={() => setShowModal(false)} centered>
        <Modal.Header closeButton>
          <Modal.Title style={{ fontWeight: 700, fontSize: 18, color: '#1e1b4b' }}>
            {currentProduct?.name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Card style={{ border: 'none' }}>
            <Card.Body>
              <div className="mb-2">
                <span style={{ fontWeight: 600, color: '#6b7280', fontSize: 13 }}>Mô tả:</span>
                <p style={{ color: '#374151', marginTop: 4 }}>{currentProduct?.description}</p>
              </div>
              <div className="mb-2">
                <span style={{ fontWeight: 600, color: '#6b7280', fontSize: 13 }}>Danh mục:</span>
                <Chip label={currentProduct?.category} size="small" sx={{ ml: 1, bgcolor: '#f3f4f6' }} />
              </div>
              <div className="mb-2">
                <span style={{ fontWeight: 600, color: '#6b7280', fontSize: 13 }}>Giá:</span>
                <Typography fontWeight={700} color="#6366f1" fontSize={20}>
                  {formatCurrency(currentProduct?.price)}₫
                </Typography>
              </div>
            </Card.Body>
          </Card>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" color="error" startIcon={<DeleteIcon />}
            onClick={() => deleteProduct(currentProduct)}
            sx={{ borderRadius: 2, textTransform: 'none' }}>Xóa</Button>
          <Link to={"/products/" + currentProduct?.id}>
            <Button variant="outlined" sx={{ borderRadius: 2, textTransform: 'none', color: '#6366f1', borderColor: '#6366f1' }}>
              Sửa
            </Button>
          </Link>
          <Button variant="contained" startIcon={<ShoppingCartRounded />}
            onClick={() => addToCart(currentProduct)}
            sx={{ borderRadius: 2, textTransform: 'none', bgcolor: '#6366f1', '&:hover': { bgcolor: '#4f46e5' } }}>
            Thêm vào giỏ
          </Button>
        </Modal.Footer>
      </Modal>

      {/* Main Content */}
      <div className="col-md-12">
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Inventory2Sharp sx={{ color: '#6366f1' }} />
            <h4 className="fw-bold mb-0" style={{ color: '#1e1b4b' }}>Sản phẩm</h4>
          </Box>
          {isAdmin && (
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button startIcon={<DeleteIcon />} variant="outlined" color="error"
                onClick={deleteAllProducts} sx={{ borderRadius: 2, textTransform: 'none' }}>Xóa tất cả</Button>
              <Link to="/products/add">
                <Button startIcon={<Add />} variant="contained"
                  sx={{ borderRadius: 2, textTransform: 'none', bgcolor: '#6366f1', '&:hover': { bgcolor: '#4f46e5' } }}>Thêm mới</Button>
              </Link>
            </Box>
          )}
        </Box>
        <hr />

        {/* Product Grid */}
        <div className="row row-cols-1 row-cols-sm-2 row-cols-md-4 g-4">
          {products.map((product, index) => (
            <div key={index} className="col">
              <Card className="product-card h-100">
                <div style={{ overflow: 'hidden' }}>
                  <Card.Img variant="top" src={`/${productImageMap[product.name] || "placeholder.png"}`}
                    onClick={() => setActiveProduct(product, index)} />
                </div>
                <Card.Body className="d-flex flex-column">
                  <Card.Title style={{ fontSize: 14, fontWeight: 600, color: '#1e1b4b', lineHeight: 1.4 }}>
                    {product.name}
                  </Card.Title>
                  <Card.Subtitle className="mb-2" style={{ fontSize: 12, color: '#9ca3af' }}>{product.category}</Card.Subtitle>
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
      </div>
    </div>
  );
};

export default connect(null)(withRouter(ProductsList));
