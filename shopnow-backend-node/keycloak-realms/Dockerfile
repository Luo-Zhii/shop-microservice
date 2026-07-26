# Sử dụng base image chính thức của Keycloak
FROM quay.io/keycloak/keycloak:latest

# Copy file cấu hình của bạn vào thư mục tự động nhận diện của Keycloak
COPY realm-export.json /opt/keycloak/data/import/

# Ra lệnh cho Keycloak tự động nạp file cấu hình này khi khởi động
CMD ["start-dev", "--import-realm"]
