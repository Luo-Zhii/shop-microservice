import React, { Component } from "react";
import { connect } from "react-redux";
import { updateProduct, deleteProduct } from "../actions/products";
import ProductService from "../services/ProductService";
import { withRouter } from '../common/WithRouter';
import Button from '@mui/material/Button';
import { Update, Delete, Edit } from "@mui/icons-material";
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

class Product extends Component {
  constructor(props) {
    super(props);
    this.onChangeName = this.onChangeName.bind(this);
    this.onChangeDescription = this.onChangeDescription.bind(this);
    this.onChangeCategory = this.onChangeCategory.bind(this);
    this.onChangePrice = this.onChangePrice.bind(this);
    this.getProduct = this.getProduct.bind(this);
    this.updateContent = this.updateContent.bind(this);
    this.removeProduct = this.removeProduct.bind(this);

    this.state = {
      currentProduct: { id: null, name: "", description: "", category: "", price: "" }
    };
  }

  componentDidMount() {
    this.getProduct(this.props.router.params.id);
  }

  onChangeName(e) {
    this.setState(prev => ({ currentProduct: { ...prev.currentProduct, name: e.target.value } }));
  }
  onChangeDescription(e) {
    this.setState(prev => ({ currentProduct: { ...prev.currentProduct, description: e.target.value } }));
  }
  onChangePrice(e) {
    this.setState(prev => ({ currentProduct: { ...prev.currentProduct, price: e.target.value } }));
  }
  onChangeCategory(e) {
    this.setState(prev => ({ currentProduct: { ...prev.currentProduct, category: e.target.value } }));
  }

  getProduct(id) {
    ProductService.get(id)
      .then((response) => this.setState({ currentProduct: response.data }))
      .catch((e) => console.log(e));
  }

  updateContent() {
    this.props.updateProduct(this.state.currentProduct.id, this.state.currentProduct)
      .then(() => toast.success("Cập nhật sản phẩm thành công!"))
      .catch((e) => console.log(e));
  }

  removeProduct() {
    this.props.deleteProduct(this.state.currentProduct.id)
      .then(() => {
        toast.success("Đã xóa sản phẩm!");
        this.props.history.push("/products");
      })
      .catch((e) => console.log(e));
  }

  render() {
    const { currentProduct } = this.state;

    return (
      <div className="row justify-content-center">
        <div className="col-md-6">
          <h4 className="mb-4 fw-bold" style={{ color: '#1e1b4b' }}>
            <Edit sx={{ mr: 1, verticalAlign: 'middle' }} /> Sửa sản phẩm
          </h4>
          {currentProduct ? (
            <div className="cardLogin" style={{ borderRadius: 16 }}>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Tên sản phẩm</label>
                <input type="text" className="form-control" value={currentProduct.name} onChange={this.onChangeName} />
              </div>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Mô tả</label>
                <input type="text" className="form-control" value={currentProduct.description} onChange={this.onChangeDescription} />
              </div>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Giá (VNĐ)</label>
                <input type="number" className="form-control" value={currentProduct.price} onChange={this.onChangePrice} />
              </div>
              <div className="form-group mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Danh mục</label>
                <input type="text" className="form-control" value={currentProduct.category} onChange={this.onChangeCategory} />
              </div>
              <div className="d-flex justify-content-center gap-2 mt-4">
                <Button startIcon={<Delete />} variant="outlined" color="error"
                  onClick={this.removeProduct} sx={{ borderRadius: 2, textTransform: 'none' }}>Xóa</Button>
                <Button startIcon={<Update />} variant="contained"
                  onClick={this.updateContent}
                  sx={{ borderRadius: 2, textTransform: 'none', bgcolor: '#6366f1', '&:hover': { bgcolor: '#4f46e5' } }}>Cập nhật</Button>
              </div>
            </div>
          ) : (
            <p className="text-center text-muted">Vui lòng chọn một sản phẩm...</p>
          )}
        </div>
      </div>
    );
  }
}

export default connect(null, { updateProduct, deleteProduct })(withRouter(Product));
