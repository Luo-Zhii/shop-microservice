import React, { useState, useEffect } from "react";
import cartService from "../services/CartService";
import { ListGroup, Button } from "react-bootstrap";
import DeleteIcon from "@mui/icons-material/Delete";
import IconButton from "@mui/material/IconButton";
import { ShoppingCartRounded, ShoppingBag } from "@mui/icons-material";
import { Box, Typography, Chip } from "@mui/material";
import "bootstrap/dist/css/bootstrap.min.css";

const CartComponent = () => {
  const [cartProducts, setCartProducts] = useState([]);
  const [totalPrice, setTotalPrice] = useState(0);
  const [cartId, setCartId] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const retrieveCart = async () => {
      const user = localStorage.getItem("user");
      if (!user) return;
      const parsedUser = JSON.parse(user);
      try {
        const response = await cartService.getByName(parsedUser.username);
        setCartId(response.data.id);
        setCartProducts(response.data.products);
        fetchTotalPrice(response.data.id);
      } catch (e) {
        console.error("Failed to retrieve cart:", e);
      }
    };
    retrieveCart();
  }, []);

  const fetchTotalPrice = async (id) => {
    try {
      const response = await cartService.getTotalPrice(id);
      setTotalPrice(response.data.total_price);
    } catch (e) {
      console.error("Failed to fetch total price:", e);
    }
  };

  const removeProductFromCart = (product) => {
    cartService.deleteProduct(cartId, product.id)
      .then((response) => {
        setCartProducts(response.data.products);
        fetchTotalPrice(cartId);
      })
      .catch((e) => console.error("Failed to remove product from cart:", e));
  };

  const formatCurrency = (amount) => {
    const number = Number(amount) || 0;
    return number.toLocaleString("vi-VN");
  };

  const handleCheckout = async () => {
    if (!cartProducts || cartProducts.length === 0) {
      alert("Giỏ hàng của bạn đang trống!");
      return;
    }
    setLoading(true);
    try {
      await cartService.delete(cartId);
      alert("Thanh toán thành công! Cảm ơn bạn đã mua hàng.");
      setCartProducts([]);
      setTotalPrice(0);
      const user = localStorage.getItem("user");
      if (user) {
        const parsedUser = JSON.parse(user);
        const response = await cartService.create(parsedUser.username);
        setCartId(response.data.id);
      }
    } catch (e) {
      console.error("Lỗi khi thanh toán:", e);
      alert("Có lỗi xảy ra khi thanh toán.");
    }
    setLoading(false);
  };

  return (
    <div className="row justify-content-center">
      <div className="col-md-8">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
          <ShoppingBag sx={{ color: '#6366f1' }} />
          <h4 className="fw-bold mb-0" style={{ color: '#1e1b4b' }}>Giỏ hàng của tôi</h4>
          {cartProducts.length > 0 && (
            <Chip label={`${cartProducts.length} sản phẩm`} size="small" sx={{ ml: 1, bgcolor: '#ede9fe', color: '#6366f1' }} />
          )}
        </Box>

        {!cartProducts || cartProducts.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 8, bgcolor: '#fafafa', borderRadius: 3 }}>
            <ShoppingCartRounded sx={{ fontSize: 64, color: '#d1d5db', mb: 2 }} />
            <Typography color="text.secondary">Giỏ hàng trống</Typography>
          </Box>
        ) : (
          <div className="cart-container">
            <ListGroup variant="flush">
              {cartProducts.map((item, i) => (
                <ListGroup.Item key={i} className="d-flex justify-content-between align-items-center py-3 px-0 border-bottom">
                  <span style={{ fontWeight: 500, color: '#374151', textTransform: 'capitalize' }}>{item.name}</span>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Typography fontWeight={600} color="#6366f1" fontSize={14}>
                      {formatCurrency(item.price)}₫
                    </Typography>
                    <IconButton size="small" onClick={() => removeProductFromCart(item)}
                      sx={{ color: '#ef4444', '&:hover': { bgcolor: '#fef2f2' } }}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                </ListGroup.Item>
              ))}
            </ListGroup>
            <div className="total-price-container">
              <span style={{ fontWeight: 600, color: '#374151' }}>Tổng tiền:</span>
              <span className="total-price">{formatCurrency(totalPrice)}₫</span>
            </div>
            <button className="btn w-100 mt-3 py-3 fw-bold" onClick={handleCheckout} disabled={loading}
              style={{
                background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                color: '#fff', border: 'none', borderRadius: 12, fontSize: 16,
                transition: 'all 0.3s'
              }}>
              {loading ? 'Đang xử lý...' : 'Thanh toán ngay'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default CartComponent;
