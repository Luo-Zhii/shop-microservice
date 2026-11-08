import React, { Component } from "react";
import { connect } from "react-redux";
import { createProduct } from "../actions/products";
import { Link } from "react-router-dom";
import Button from '@mui/material/Button';
import { Add, ArrowBack, Inventory } from "@mui/icons-material";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

class AddProduct extends Component {
  constructor(props) {
    super(props);
    this.onChangeName = this.onChangeName.bind(this);
    this.onChangeDescription = this.onChangeDescription.bind(this);
    this.onChangeCategory = this.onChangeCategory.bind(this);
    this.onChangePrice = this.onChangePrice.bind(this);
    this.saveProduct = this.saveProduct.bind(this);
    this.newProduct = this.newProduct.bind(this);
    this.state = { id: null, name: "", description: "", category: "", price: "", submitted: false };
  }

  onChangeName(e) { this.setState({ name: e.target.value }); }
  onChangeDescription(e) { this.setState({ description: e.target.value }); }
  onChangePrice(e) { this.setState({ price: e.target.value }); }
  onChangeCategory(e) { this.setState({ category: e.target.value }); }

  saveProduct() {
    const { name, description, category, price } = this.state;
    this.props.createProduct(name, description, category, price)
      .then((data) => {
        this.setState({
          id: data.id, name: data.name, description: data.description,
          category: data.category, price: data.price, submitted: true,
        });
        toast.success("Đã thêm sản phẩm mới!");
      })
      .catch((e) => console.log(e));
  }

  newProduct() {
    this.setState({ id: null, name: "", description: "", category: "", price: "", submitted: false });
  }

  render() {
    return (
      <div className="row justify-content-center">
        <div className="col-md-6">
          <h4 className="mb-4 fw-bold" style={{ color: '#1e1b4b' }}>
            <Inventory sx={{ mr: 1, verticalAlign: 'middle' }} /> Thêm sản phẩm
          </h4>
          {this.state.submitted ? (
            <div className="text-center cardLogin" style={{ borderRadius: 16 }}>
              <h5 className="text-success mb-3">Đã thêm thành công!</h5>
              <div className="d-flex justify-content-center gap-2">
                <Button startIcon={<Add />} variant="contained" onClick={this.newProduct}
                  sx={{ borderRadius: 2, textTransform: 'none', bgcolor: '#6366f1' }}>Thêm tiếp</Button>
                <Link to="/products">
                  <Button startIcon={<ArrowBack />} variant="outlined"
                    sx={{ borderRadius: 2, textTransform: 'none' }}>Quay lại</Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="cardLogin" style={{ borderRadius: 16 }}>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Tên sản phẩm</label>
                <input type="text" className="form-control" value={this.state.name}
                  onChange={this.onChangeName} placeholder="Nhập tên sản phẩm" />
              </div>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Mô tả</label>
                <input type="text" className="form-control" value={this.state.description}
                  onChange={this.onChangeDescription} placeholder="Mô tả ngắn gọn" />
              </div>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Giá (VNĐ)</label>
                <input type="number" className="form-control" value={this.state.price}
                  onChange={this.onChangePrice} placeholder="0" />
              </div>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Danh mục</label>
                <input type="text" className="form-control" value={this.state.category}
                  onChange={this.onChangeCategory} placeholder="VD: Điện thoại, Thời trang..." />
              </div>
              <div className="d-flex justify-content-center mt-4">
                <Button startIcon={<Add />} variant="contained" onClick={this.saveProduct}
                  sx={{ borderRadius: 2, textTransform: 'none', bgcolor: '#6366f1', '&:hover': { bgcolor: '#4f46e5' } }}>
                  Thêm sản phẩm
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
}

export default connect(null, { createProduct })(AddProduct);
