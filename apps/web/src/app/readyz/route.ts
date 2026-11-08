export const dynamic = 'force-dynamic';

// Readiness của web: tiến trình Next đã phục vụ được request (không phụ thuộc backend — FE tự xử lý khi API lỗi).
export function GET() {
  return Response.json({ status: 'ok' });
}
