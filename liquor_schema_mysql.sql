-- Club Liquor Shop: database schema (MySQL 8+)
CREATE DATABASE IF NOT EXISTS club_liquor_shop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE club_liquor_shop;

CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          ENUM('boss', 'cashier') NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product_types (
    id   INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(150) NOT NULL,
    type_id       INT NOT NULL,
    buying_price  DECIMAL(10,2) NOT NULL CHECK (buying_price >= 0),
    selling_price DECIMAL(10,2) NOT NULL CHECK (selling_price >= 0),
    quantity      INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (type_id) REFERENCES product_types(id),
    INDEX idx_products_type (type_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_entries (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    product_id   INT NOT NULL,
    quantity     INT NOT NULL CHECK (quantity > 0),
    buying_price DECIMAL(10,2) NOT NULL,
    added_by     INT NOT NULL,
    added_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (added_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sales (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    receipt_no     VARCHAR(30) NOT NULL UNIQUE,
    cashier_id     INT NOT NULL,
    total_amount   DECIMAL(10,2) NOT NULL CHECK (total_amount >= 0),
    payment_method ENUM('cash', 'mpesa') NOT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cashier_id) REFERENCES users(id),
    INDEX idx_sales_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sale_items (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    sale_id    INT NOT NULL,
    product_id INT NOT NULL,
    quantity   INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10,2) NOT NULL,
    unit_cost  DECIMAL(10,2) NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mpesa_payments (
    id                   INT AUTO_INCREMENT PRIMARY KEY,
    sale_id              INT NULL,
    phone_number         VARCHAR(15) NOT NULL,
    amount               DECIMAL(10,2) NOT NULL,
    merchant_request_id  VARCHAR(100),
    checkout_request_id  VARCHAR(100) UNIQUE,
    mpesa_receipt_number VARCHAR(30),
    status               ENUM('pending', 'success', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
    result_desc          VARCHAR(255),
    created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TIMESTAMP NULL ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sale_id) REFERENCES sales(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    user_id    INT NULL,
    action     VARCHAR(100) NOT NULL,
    details    TEXT,
    ip_address VARCHAR(45),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB;
