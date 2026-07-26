import React, { Component } from "react";
import { Navigate, Link } from 'react-router-dom';
import { connect } from "react-redux";
import { Card } from "react-bootstrap";
import Button from '@mui/material/Button';
import { ModeEdit, Person } from "@mui/icons-material";

class Profile extends Component {
  render() {
    const { user: currentUser } = this.props;

    if (!currentUser) return <Navigate to="/login" />;

    return (
      <div className="row justify-content-center">
        <div className="col-md-6">
          <h4 className="mb-4 fw-bold" style={{ color: '#1e1b4b' }}>
            <Person sx={{ mr: 1, verticalAlign: 'middle' }} /> Tài khoản của tôi
          </h4>
          <Card style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid #e8e8e8', boxShadow: '0 4px 20px rgba(0,0,0,0.04)' }}>
            <div style={{
              background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
              padding: '40px 20px', textAlign: 'center', color: '#fff'
            }}>
              <div style={{
                width: 80, height: 80, borderRadius: '50%', background: 'rgba(255,255,255,0.2)',
                margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <Person sx={{ fontSize: 40 }} />
              </div>
              <h5 className="mb-1" style={{ fontWeight: 700 }}>{currentUser.username}</h5>
              <p className="mb-0" style={{ opacity: 0.85, fontSize: 14 }}>{currentUser.email}</p>
            </div>
            <Card.Body className="p-4">
              <div className="mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Username
                </label>
                <p style={{ color: '#1e1b4b', fontSize: 16 }}>{currentUser.username}</p>
              </div>
              <div className="mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Email
                </label>
                <p style={{ color: '#1e1b4b', fontSize: 16 }}>{currentUser.email}</p>
              </div>
              <div className="mb-3">
                <label style={{ fontWeight: 600, color: '#374151', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Access Token
                </label>
                <p style={{ color: '#9ca3af', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {currentUser.accessToken?.substring(0, 24)}...{currentUser.accessToken?.substr(currentUser.accessToken.length - 24)}
                </p>
              </div>
              <div className="d-flex justify-content-end mt-3">
                <Link to={"/profile/" + currentUser.id}>
                  <Button startIcon={<ModeEdit />} variant="outlined"
                    sx={{ borderRadius: 2, textTransform: 'none', color: '#6366f1', borderColor: '#6366f1' }}>
                    Chỉnh sửa
                  </Button>
                </Link>
              </div>
            </Card.Body>
          </Card>
        </div>
      </div>
    );
  }
}

function mapStateToProps(state) {
  return { user: state.auth.user };
}

export default connect(mapStateToProps)(Profile);
