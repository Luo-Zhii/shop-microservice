'use client';

import { ProductForm } from '@/components/seller/product-form';
import { PageTitle } from '@/components/ui';

export default function NewProductPage() {
  return (
    <div>
      <PageTitle back="/seller/products">Thêm sản phẩm</PageTitle>
      <ProductForm />
    </div>
  );
}
