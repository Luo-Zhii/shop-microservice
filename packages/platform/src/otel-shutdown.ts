// Tách riêng để server.ts không kéo theo khởi tạo SDK; main.ts import '@shopnow/platform/otel' trước.
export async function shutdownTelemetry() {
  const mod = await import('./otel').catch(() => undefined);
  await mod?.shutdownTelemetry();
}
