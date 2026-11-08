# Khai báo các biến nhạy cảm
variable "keycloak_client_secret" {
  type      = string
  sensitive = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

# Tạo Két sắt AWS Secrets Manager
resource "aws_secretsmanager_secret" "app_env_secrets" {
  name        = "dev-shopnow-env-vars-v2"
  description = "Kho lưu trữ toàn bộ biến môi trường và cấu hình backend"
}

# Đút toàn bộ dữ liệu vào Két sắt dưới dạng chuỗi JSON (JavaScript Object Notation)
resource "aws_secretsmanager_secret_version" "app_env_secrets_version" {
  secret_id     = aws_secretsmanager_secret.app_env_secrets.id
  secret_string = jsonencode({
    PORT                   = "5865"
    DB_HOST                = aws_db_instance.shop_postgres.address
    DB_PORT                = "5432"
    DB_NAME                = "postgres"
    DB_USER                = "shop_admin"
    DB_PASSWORD            = var.db_password
    
    KEYCLOAK_TOKEN_URL     = "http://keycloak:8080/realms/java-microservice-realm/protocol/openid-connect/token"
    KEYCLOAK_CLIENT_ID     = "spring-cloud-client"
    KEYCLOAK_CLIENT_SECRET = var.keycloak_client_secret
    KEYCLOAK_GRANT_TYPE    = "client_credentials"
    KEYCLOAK_SCOPE         = "openid offline_access"
    
    CART_SERVICE_URL       = "http://shopping-cart-service:5863"
  })
}

# Triệu hồi RDS PostgreSQL (Relational Database Service)
resource "aws_db_instance" "shop_postgres" {
  identifier             = "shopnow-postgres-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  username               = "shop_admin"
  password               = var.db_password
  skip_final_snapshot    = true
}