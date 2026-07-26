provider "aws" {
  region = "ap-southeast-1"
}

# Khai báo danh sách các kho ECR cần tạo
locals {
  ecr_repos = [
    "dev/user-service",
    "dev/shopping-cart-service",
    "dev/product-service",
    "dev/api-gateway",
    "dev/keycloak-realms"
  ]
}

# Terraform sẽ lặp qua danh sách trên và tạo các ECR Repositories
resource "aws_ecr_repository" "shop_microservices" {
  for_each             = toset(local.ecr_repos)
  name                 = each.key
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true # Tự động quét lỗ hổng bảo mật khi đẩy Image lên
  }
}