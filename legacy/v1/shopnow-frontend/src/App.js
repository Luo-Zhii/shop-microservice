import React, { Component } from "react";
import { Routes, Route, Link } from "react-router-dom";
import { Container, Navbar, Nav, Form, FormControl, Button } from "react-bootstrap";
import { Search, ShoppingCart, Notifications, Language } from "@mui/icons-material";
import "bootstrap/dist/css/bootstrap.min.css";
import "./App.css";

import LoginComponent from "./components/LoginComponent";
import RegisterComponent from "./components/RegisterComponent";
import HomeComponent from "./components/HomeComponent";
import ProfileComponent from "./components/ProfileComponent";
import ProductsListComponent from "./components/ProductsListComponent";
import CartComponent from "./components/CartComponent";
import AddProductComponent from "./components/AddProductComponent";
import ProductEditComponent from "./components/ProductEditComponent";

import { logout } from "./actions/auth";
import { connect } from "react-redux";
import { clearMessage } from "./actions/message";
import { history } from './helpers/history';

import AuthVerify from "./common/AuthVerify";
import EventBus from "./common/EventBus";
import { Person } from "@mui/icons-material";
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import ProfileEditComponent from "./components/ProfileEditComponent";

class App extends Component {
  constructor(props) {
    super(props);
    this.logOut = this.logOut.bind(this);

    this.state = {
      currentUser: undefined,
    };

    history.listen((location) => {
      props.dispatch(clearMessage());
    });
  }

  componentDidMount() {
    const user = this.props.user;

    if (user) {
      this.setState({
        currentUser: user
      });
    }

    EventBus.on("logout", () => {
      this.logOut();
    });
  }

  componentWillUnmount() {
    EventBus.remove("logout");
  }

  logOut() {
    this.props.dispatch(logout());
    this.setState({
      currentUser: undefined,
    });
  }

  render() {
    const { currentUser } = this.state;

    return (
      <>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

          * { font-family: 'Inter', system-ui, -apple-system, sans-serif; }

          /* === Header === */
          .header-container {
            top: 0;
            position: sticky;
            z-index: 1000;
            box-shadow: 0 2px 20px rgba(0,0,0,0.08);
          }

          .header-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #3730a3 100%);
            color: #e0e7ff;
            font-size: 13px;
            padding: 8px 24px;
            font-weight: 500;
          }
          .header-top a {
            color: #c7d2fe;
            text-decoration: none;
            margin-left: 18px;
            transition: color 0.2s;
          }
          .header-top a:hover { color: #fff; }

          /* === Navbar === */
          .navbar {
            background: #fff;
            padding: 12px 24px;
          }
          .navbar .navbar-brand img { height: 36px; }

          .search-form {
            display: flex;
            width: 520px;
            border: 2px solid #e8e8e8;
            border-radius: 12px;
            overflow: hidden;
            transition: all 0.3s;
          }
          .search-form:focus-within {
            border-color: #6366f1;
            box-shadow: 0 0 0 4px rgba(99,102,241,0.08);
          }
          .search-form input {
            flex: 1;
            border: none;
            padding: 10px 16px;
            font-size: 14px;
            outline: none;
          }
          .search-button {
            background: #6366f1;
            border: none;
            padding: 10px 20px;
            color: white;
            display: flex;
            align-items: center;
            transition: background 0.2s;
          }
          .search-button:hover { background: #4f46e5; }

          .nav-icons a {
            color: #374151;
            margin-left: 16px;
            position: relative;
            transition: color 0.2s;
            font-size: 24px;
          }
          .nav-icons a:hover { color: #6366f1; }

          .auth-links a, .auth-links .btn-link {
            color: #c7d2fe;
            margin-left: 8px;
            text-decoration: none;
            font-weight: 500;
          }
          .auth-links a:hover { color: #fff; }

          /* === Container === */
          .main-container {
            min-height: 70vh;
            padding-bottom: 40px;
          }

          /* === Footer === */
          .site-footer {
            background: #f8fafc;
            border-top: 1px solid #e2e8f0;
            padding: 32px 0 16px;
            margin-top: 60px;
          }
          .site-footer h5 { font-weight: 700; color: #1e1b4b; margin-bottom: 12px; }
          .site-footer a { color: #64748b; text-decoration: none; transition: color 0.2s; }
          .site-footer a:hover { color: #6366f1; }
        `}</style>

        <div className="header-container">
          {/* Header Top Bar */}
          <div className="header-top">
            <div>
              <a href="/products">Sản phẩm</a>
              <a href="/cart">Giỏ hàng</a>
              <a href="/">Trang chủ</a>
            </div>
            <div>
              <a href="#" style={{ marginRight: 4 }}><Language fontSize="small" /> Tiếng Việt</a>
              {currentUser ? (
                <span className="auth-links">
                  <Link to="/profile"><Person fontSize="small" /> {currentUser.username}</Link>
                  <a href="#" onClick={this.logOut}>Đăng xuất</a>
                </span>
              ) : (
                <span className="auth-links">
                  <Link to="/register">Đăng ký</Link>
                  <Link to="/login">Đăng nhập</Link>
                </span>
              )}
            </div>
          </div>

          {/* Main Navbar */}
          <Navbar expand="lg" className="navbar">
            <Container fluid>
              <Navbar.Brand as={Link} to="/">
                <img src="/Shop now-logo.png" alt="ShopNow" />
              </Navbar.Brand>

              <Form className="search-form d-none d-md-flex">
                <FormControl type="search" placeholder="Bạn muốn tìm gì hôm nay?" aria-label="Search" />
                <Button className="search-button"><Search /></Button>
              </Form>

              <div className="nav-icons">
                <Link to="/cart"><ShoppingCart /></Link>
              </div>
            </Container>
          </Navbar>
        </div>

        {/* Main Content */}
        <div className="main-container container mt-4">
          <Routes>
            <Route path="/" element={<HomeComponent />} />
            <Route path="/login" element={<LoginComponent />} />
            <Route path="/register" element={<RegisterComponent />} />
            <Route path="/cart" element={<CartComponent />} />
            {currentUser && (
              <>
                <Route path="/profile" element={<ProfileComponent />} />
                <Route path="/profile/:id" element={<ProfileEditComponent />} />
                <Route path="/products" element={<ProductsListComponent />} />
                <Route path="/products/add" element={<AddProductComponent />} />
                <Route path="/products/:id" element={<ProductEditComponent />} />
              </>
            )}
          </Routes>
        </div>

        <ToastContainer position="bottom-right" autoClose={3000} />

        {/* Modern Footer */}
        <footer className="site-footer">
          <Container>
            <div className="row">
              <div className="col-md-4 mb-3">
                <h5>ShopNow</h5>
                <p className="text-muted" style={{ fontSize: 14 }}>
                  Nền tảng thương mại điện tử hàng đầu Việt Nam. <br />
                  Mua sắm dễ dàng, giao hàng nhanh chóng.
                </p>
              </div>
              <div className="col-md-4 mb-3">
                <h5>Liên kết</h5>
                <ul className="list-unstyled">
                  <li className="mb-1"><a href="/">Trang chủ</a></li>
                  <li className="mb-1"><a href="/products">Sản phẩm</a></li>
                  <li className="mb-1"><a href="/cart">Giỏ hàng</a></li>
                  <li className="mb-1"><a href="/profile">Tài khoản</a></li>
                </ul>
              </div>
              <div className="col-md-4 mb-3">
                <h5>Liên hệ</h5>
                <ul className="list-unstyled text-muted" style={{ fontSize: 14 }}>
                  <li className="mb-1">Email: support@shopnow.vn</li>
                  <li className="mb-1">Hotline: 1900 1234</li>
                  <li className="mb-1">TP. Hồ Chí Minh, Việt Nam</li>
                </ul>
              </div>
            </div>
            <hr className="my-3" />
            <p className="text-center text-muted mb-0" style={{ fontSize: 13 }}>
              &copy; {new Date().getFullYear()} ShopNow. All rights reserved.
            </p>
          </Container>
        </footer>

        <AuthVerify logOut={this.logOut} />
      </>
    );
  }
}

function mapStateToProps(state) {
  const { user } = state.auth;
  return { user };
}

export default connect(mapStateToProps)(App);
