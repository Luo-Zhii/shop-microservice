import React, { Component } from "react";
import { connect } from "react-redux";
import { Link } from 'react-router-dom';
import { withRouter } from '../common/WithRouter';
import Button from '@mui/material/Button';
import { Delete, ArrowBack, Save, Person } from "@mui/icons-material";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { updateProfile, deleteProfile } from "../actions/profile";

class ProfileEdit extends Component {
  constructor(props) {
    super(props);
    this.onChangeEmail = this.onChangeEmail.bind(this);
    this.onChangePassword = this.onChangePassword.bind(this);
    this.state = {
      currentProfile: { id: null, password: undefined, email: undefined }
    };
  }

  componentDidMount() {
    const { user: currentUser } = this.props;
    this.setState({ currentProfile: { id: currentUser.id } });
  }

  onChangeEmail(e) {
    this.setState(prev => ({ currentProfile: { ...prev.currentProfile, email: e.target.value } }));
  }

  onChangePassword(e) {
    this.setState(prev => ({ currentProfile: { ...prev.currentProfile, password: e.target.value } }));
  }

  deleteProfile = () => {
    if (!window.confirm("Bạn có chắc muốn xóa tài khoản?")) return;
    this.props.deleteProfile(this.state.currentProfile.id)
      .then(() => {
        toast.success("Đã xóa tài khoản!");
        this.props.logOut();
        this.props.router.navigate("/login");
      })
      .catch((e) => console.log(e));
  }

  updateProfile = () => {
    if (!this.state.currentProfile.email && !this.state.currentProfile.password) {
      alert("Vui lòng nhập email hoặc mật khẩu mới");
      return;
    }
    this.props.updateProfile(this.state.currentProfile.id, this.state.currentProfile)
      .then(() => {
        toast.success("Cập nhật thành công! Vui lòng đăng nhập lại.");
        this.props.logOut();
        this.props.router.navigate("/login");
      })
      .catch((e) => console.log(e));
  }

  render() {
    const { message } = this.props;
    return (
      <div className="row justify-content-center">
        <div className="col-md-6">
          <h4 className="mb-4 fw-bold" style={{ color: '#1e1b4b' }}>
            <Person sx={{ mr: 1, verticalAlign: 'middle' }} /> Chỉnh sửa tài khoản
          </h4>
          <div className="cardLogin" style={{ borderRadius: 16 }}>
            <div className="form-group mb-3">
              <label style={{ fontWeight: 600, color: '#374151', fontSize: 14, marginBottom: 6 }}>
                Email mới <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 400 }}>(tùy chọn)</span>
              </label>
              <input type="email" className="form-control" onChange={this.onChangeEmail} placeholder="email@example.com" />
            </div>
            <div className="form-group mb-3">
              <label style={{ fontWeight: 600, color: '#374151', fontSize: 14, marginBottom: 6 }}>
                Mật khẩu mới <span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 400 }}>(tùy chọn)</span>
              </label>
              <input type="password" className="form-control" onChange={this.onChangePassword} placeholder="Tối thiểu 6 ký tự" />
            </div>
            {message && <div className="alert alert-danger">{message}</div>}
            <div className="d-flex justify-content-center gap-2 mt-4">
              <Button startIcon={<Delete />} variant="outlined" color="error"
                onClick={this.deleteProfile} sx={{ borderRadius: 2, textTransform: 'none' }}>Xóa</Button>
              <Button startIcon={<Save />} variant="contained"
                onClick={this.updateProfile}
                sx={{ borderRadius: 2, textTransform: 'none', bgcolor: '#6366f1', '&:hover': { bgcolor: '#4f46e5' } }}>Lưu</Button>
              <Link to="/profile">
                <Button startIcon={<ArrowBack />} variant="outlined"
                  sx={{ borderRadius: 2, textTransform: 'none', color: '#6366f1', borderColor: '#6366f1' }}>Quay lại</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

function mapStateToProps(state) {
  const { user } = state.auth;
  const { message } = state.message;
  return { user, message };
}

export default connect(mapStateToProps, { updateProfile, deleteProfile })(withRouter(ProfileEdit));
