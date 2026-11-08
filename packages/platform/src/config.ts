import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const baseConfigSchema = z.object({
  NODE_ENV: z.string().default('development'),
  SERVICE_NAME: z.string().default('service'),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default('info'),
  JWKS_URL: z.string().default('http://localhost:8101/.well-known/jwks.json'),
  JWT_ISSUER: z.string().default('shopnow-identity'),
  JWT_AUDIENCE: z.string().default('shopnow'),
  INTERNAL_TOKEN: z.string().default('dev-internal-token'),
  KAFKA_BROKERS: z.string().default('localhost:59092'),
  KAFKA_ENABLED: bool.default(true),
  CORS_ORIGINS: z.string().default('*'),
});

export type BaseConfig = z.infer<typeof baseConfigSchema>;

/** Đọc & validate biến môi trường. Lỗi cấu hình → thoát ngay khi khởi động (fail fast). */
export function loadConfig<T extends z.ZodRawShape>(
  serviceName: string,
  defaultPort: number,
  extra: T,
): BaseConfig & z.infer<z.ZodObject<T>> {
  const schema = baseConfigSchema.extend(extra);
  const parsed = schema.safeParse({ SERVICE_NAME: serviceName, PORT: defaultPort, ...process.env });
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(`[${serviceName}] cấu hình không hợp lệ`, parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data as BaseConfig & z.infer<z.ZodObject<T>>;
}

export { bool as envBool };
