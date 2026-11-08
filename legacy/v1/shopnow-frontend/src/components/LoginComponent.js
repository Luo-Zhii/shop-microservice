import React, { Component } from "react";
import { Navigate, Link } from 'react-router-dom';
import Form from "react-validation/build/form";
import CheckButton from "react-validation/build/button";
import { connect } from "react-redux";
import { login } from "../actions/auth";

const required = (value) => {
  if (!value) {
    return <div className="alert alert-danger" role="alert">Vui lòng nhập trường này!</div>;
  }
};

class Login extends Component {
  constructor(props) {
    super(props);
    this.handleLogin = this.handleLogin.bind(this);
    this.onChangeUsername = this.onChangeUsername.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);
    this.state = { username: "", password: "", loading: false };
  }

  onChangeUsername(e) { this.setState({ username: e.target.value }); }
  onChangePassword(e) { this.setState({ password: e.target.value }); }

  handleLogin(e) {
    e.preventDefault();
    this.setState({ loading: true });
    this.form.validateAll();
    const { dispatch } = this.props;
    if (this.checkBtn.context._errors.length === 0) {
      dispatch(login(this.state.username, this.state.password))
        .then(() => window.location.reload())
        .catch(() => this.setState({ loading: false }));
    } else {
      this.setState({ loading: false });
    }
  }

  render() {
    const { isLoggedIn, message } = this.props;
    if (isLoggedIn) return <Navigate to="/" />;

    return (
      <div className="col-md-12">
        <div className="cardLogin card-container text-center">
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
            margin: '0 auto 24px', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <span style={{ color: '#fff', fontSize: 32, fontWeight: 700 }}>S</span>
          </div>
          <h5 style={{ fontWeight: 700, color: '#1e1b4b', marginBottom: 8 }}>Đăng nhập</h5>
          <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 24 }}>
            Chào mừng bạn quay lại ShopNow
          </p>

          <Form onSubmit={this.handleLogin} ref={(c) => { this.form = c; }}>
            <div className="form-group text-start">
              <label htmlFor="username" style={{ fontWeight: 500, color: '#374151', fontSize: 14 }}>Tên đăng nhập</label>
              <input type="text" className="form-control" name="username"
                value={this.state.username} onChange={this.onChangeUsername} validations={[required]}
                placeholder="Nhập username" />
            </div>
            <div className="form-group text-start mt-3">
              <label htmlFor="password" style={{ fontWeight: 500, color: '#374151', fontSize: 14 }}>Mật khẩu</label>
              <input type="password" className="form-control" name="password"
                value={this.state.password} onChange={this.onChangePassword} validations={[required]}
                placeholder="Nhập mật khẩu" />
            </div>
            <div className="form-group mt-4">
              <button className="btn btn-primary w-100 py-2 fw-bold" disabled={this.state.loading}
                style={{ fontSize: 15 }}>
                {this.state.loading && <span className="spinner-border spinner-border-sm me-2"></span>}
                Đăng nhập
              </button>
            </div>
            {message && (
              <div className="form-group mt-3">
                <div className="alert alert-info" role="alert">{message}</div>
              </div>
            )}
            <p className="mt-3 mb-0" style={{ fontSize: 14, color: '#6b7280' }}>
              Chưa có tài khoản? <Link to="/register" style={{ color: '#6366f1', fontWeight: 600 }}>Đăng ký ngay</Link>
            </p>
            <CheckButton style={{ display: "none" }} ref={(c) => { this.checkBtn = c; }} />
          </Form>
        </div>
      </div>
    );
  }
}

function mapStateToProps(state) {
  const { isLoggedIn } = state.auth;
  const { message } = state.message;
  return { isLoggedIn, message };
}

export default connect(mapStateToProps)(Login);
