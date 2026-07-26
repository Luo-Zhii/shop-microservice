output "rds_endpoint" {
  description = "Địa chỉ kết nối đến RDS PostgreSQL"
  value       = aws_db_instance.shop_postgres.address
}

