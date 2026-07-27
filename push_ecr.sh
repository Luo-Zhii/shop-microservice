#!/bin/bash

# Khai báo các biến môi trường
AWS_ACCOUNT_ID="975050330242"
AWS_REGION="ap-southeast-1"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

echo "Bắt đầu đăng nhập vào AWS ECR..."
cd "shopnow-backend-node"
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY

# Danh sách các dịch vụ cần build và push (Tên thư mục cấu hình tương ứng với tên repo)
# Lưu ý: Cấu trúc này giả định bạn đang đứng ở thư mục gốc chứa các thư mục con của từng service.
SERVICES=("api-gateway" "keycloak-realms" "product-service" "shopping-cart-service" "user-service")

for SERVICE in "${SERVICES[@]}"; do
    echo "=========================================="
    echo "Đang xử lý: dev/$SERVICE"
    
    # 1. Build image (Giả sử thư mục code trùng tên với tên service)
    # Nếu đường dẫn Dockerfile của bạn khác, hãy điều chỉnh lại đoạn ./$SERVICE
    docker build -t dev/$SERVICE ./$SERVICE
    
    # 2. Tag image với registry URI
    docker tag dev/$SERVICE:latest $ECR_REGISTRY/dev/$SERVICE:latest
    
    # 3. Push lên ECR
    docker push $ECR_REGISTRY/dev/$SERVICE:latest
    
    echo "Đã đẩy thành công: dev/$SERVICE"
done

echo "Hoàn tất đẩy toàn bộ images lên ECR!"