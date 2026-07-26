import React, { Component } from "react";
import { Link } from "react-router-dom";
import Form from "react-validation/build/form";
import CheckButton from "react-validation/build/button";
import { isEmail } from "validator";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { connect } from "react-redux";
import { register } from "../actions/auth";

const required = (value) => {
  if (!value) return <div className="alert alert-danger" role="alert">Vui lòng nhập trường này!</div>;
};

const validEmail = (value) => {
  if (!isEmail(value)) return <div className="alert alert-danger" role="alert">Email không hợp lệ.</div>;
};

const vusername = (value) => {
  if (value.length < 3 || value.length > 20)
    return <div className="alert alert-danger" role="alert">Username phải từ 3-20 ký tự.</div>;
};

const vpassword = (value) => {
  if (value.length < 6 || value.length > 40)
    return <div className="alert alert-danger" role="alert">Mật khẩu phải từ 6-40 ký tự.</div>;
};

class Register extends Component {
  constructor(props) {
    super(props);
    this.handleRegister = this.handleRegister.bind(this);
    this.onChangeUsername = this.onChangeUsername.bind(this);
    this.onChangeEmail = this.onChangeEmail.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);
    this.state = { username: "", email: "", password: "", successful: false };
  }

  onChangeUsername(e) { this.setState({ username: e.target.value }); }
  onChangeEmail(e) { this.setState({ email: e.target.value }); }
  onChangePassword(e) { this.setState({ password: e.target.value }); }

  handleRegister(e) {
    e.preventDefault();
    this.setState({ successful: false });
    this.form.validateAll();
    if (this.checkBtn.context._errors.length === 0) {
      this.props.dispatch(register(this.state.username, this.state.email, this.state.password))
        .then(() => {
          toast.success("Đăng ký thành công! Bạn có thể đăng nhập ngay.");
          this.setState({ successful: true });
        })
        .catch(() => this.setState({ successful: false }));
    }
  }

  render() {
    const { message } = this.props;

    return (
      <div className="col-md-12">
        <div className="cardLogin card-container text-center">
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'linear-gradient(135deg, #ec4899, #db2777)',
            margin: '0 auto 24px', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <span style={{ color: '#fff', fontSize: 32, fontWeight: 700 }}>+</span>
          </div>
          <h5 style={{ fontWeight: 700, color: '#1e1b4b', marginBottom: 8 }}>Đăng ký</h5>
          <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 24 }}>
            Tạo tài khoản ShopNow miễn phí
          </p>

          <Form onSubmit={this.handleRegister} ref={(c) => { this.form = c; }}>
            {!this.state.successful && (
              <div>
                <div className="form-group text-start">
                  <label style={{ fontWeight: 500, color: '#374151', fontSize: 14 }}>Tên đăng nhập</label>
                  <input type="text" className="form-control" name="username"
                    value={this.state.username} onChange={this.onChangeUsername}
                    validations={[required, vusername]} placeholder="Từ 3-20 ký tự" />
                </div>
                <div className="form-group text-start mt-3">
                  <label style={{ fontWeight: 500, color: '#374151', fontSize: 14 }}>Email</label>
                  <input type="text" className="form-control" name="email"
                    value={this.state.email} onChange={this.onChangeEmail}
                    validations={[required, validEmail]} placeholder="example@email.com" />
                </div>
                <div className="form-group text-start mt-3">
                  <label style={{ fontWeight: 500, color: '#374151', fontSize: 14 }}>Mật khẩu</label>
                  <input type="password" className="form-control" name="password"
                    value={this.state.password} onChange={this.onChangePassword}
                    validations={[required, vpassword]} placeholder="Từ 6-40 ký tự" />
                </div>
                <div className="form-group mt-4">
                  <button className="btn btn-primary w-100 py-2 fw-bold" style={{ fontSize: 15, background: 'linear-gradient(135deg, #ec4899, #db2777)' }}>
                    Đăng ký
                  </button>
                </div>
              </div>
            )}
            {message && (
              <div className="form-group mt-3">
                <div className={this.state.successful ? "alert alert-success" : "alert alert-danger"} role="alert">
                  {message}
                </div>
              </div>
            )}
            {!this.state.successful && (
              <p className="mt-3 mb-0" style={{ fontSize: 14, color: '#6b7280' }}>
                Đã có tài khoản? <Link to="/login" style={{ color: '#6366f1', fontWeight: 600 }}>Đăng nhập</Link>
              </p>
            )}
            <CheckButton style={{ display: "none" }} ref={(c) => { this.checkBtn = c; }} />
          </Form>
        </div>
      </div>
    );
  }
}

function mapStateToProps(state) {
  return { message: state.message.message };
}

export default connect(mapStateToProps)(Register);
