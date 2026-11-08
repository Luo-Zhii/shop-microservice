-- ==========================================
-- Xoá các bảng cũ (nếu có) để đảm bảo schema luôn được cập nhật chính xác
-- Cảnh báo: Lệnh này sẽ xoá dữ liệu cũ. Hãy cẩn thận trên môi trường Production.
-- ==========================================
DROP TABLE IF EXISTS shopping_cart_product CASCADE;
DROP TABLE IF EXISTS shopping_cart CASCADE;
DROP TABLE IF EXISTS product_cart CASCADE;
DROP TABLE IF EXISTS product CASCADE;
DROP TABLE IF EXISTS userservice_users CASCADE;

-- ==========================================
-- Product Service Database Models
-- ==========================================

-- Bảng quản lý sản phẩm
CREATE TABLE IF NOT EXISTS product (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price BIGINT NOT NULL,
    description TEXT,
    category VARCHAR(255)
);

-- ==========================================
-- Shopping Cart Service Database Models
-- ==========================================

-- Bảng lưu trữ thông tin sản phẩm cục bộ (sử dụng ID từ Product Service)
CREATE TABLE IF NOT EXISTS product_cart (
    id BIGINT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price BIGINT NOT NULL,
    description TEXT,
    category VARCHAR(255)
);

-- Bảng giỏ hàng
CREATE TABLE IF NOT EXISTS shopping_cart (
    id BIGSERIAL PRIMARY KEY,
    shopping_cart_name VARCHAR(255) NOT NULL UNIQUE
);

-- Bảng trung gian (Junction table) biểu diễn mối quan hệ Many-to-Many giữa ShoppingCart và Product
CREATE TABLE IF NOT EXISTS shopping_cart_product (
    shopping_cart_id BIGINT NOT NULL,
    product_id BIGINT NOT NULL,
    PRIMARY KEY (shopping_cart_id, product_id),
    CONSTRAINT fk_shopping_cart_product_cart_id 
        FOREIGN KEY (shopping_cart_id) 
        REFERENCES shopping_cart(id) 
        ON DELETE CASCADE,
    CONSTRAINT fk_shopping_cart_product_product_id 
        FOREIGN KEY (product_id) 
        REFERENCES product_cart(id) 
        ON DELETE CASCADE
);

-- ==========================================
-- User Service Database Models
-- ==========================================

-- Bảng quản lý người dùng
CREATE TABLE IF NOT EXISTS userservice_users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(20) NOT NULL UNIQUE,
    email VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(120) NOT NULL
);