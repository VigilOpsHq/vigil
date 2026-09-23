// Worker bindings and request context types.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface R2Object {
  key: string;
  size: number;
  body: ReadableStream;
  httpEtag: string;
}

export interface R2UploadedPart {
  partNumber: number;
  etag: string;
}

export interface R2MultipartUpload {
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | string): Promise<R2UploadedPart>;
  complete(parts: R2UploadedPart[]): Promise<R2Object>;
  abort(): Promise<void>;
}

export interface R2Bucket {
  head(key: string): Promise<Omit<R2Object, 'body'> | null>;
  get(key: string): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  createMultipartUpload(key: string): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DB?: D1Database;
  BACKUPS?: R2Bucket;

  BACHS_API_KEY?: string;
  BACHS_API_BASE?: string;
  BACHS_WEBHOOK_SECRET?: string;
  BACHS_PRODUCT_PRO_MONTHLY?: string;
  BACHS_PRODUCT_PRO_YEARLY?: string;
  BACHS_PRODUCT_TEAM_MONTHLY?: string;
  BACHS_PRODUCT_TEAM_YEARLY?: string;

  SALES_TELEGRAM_BOT_TOKEN?: string;
  SALES_TELEGRAM_CHAT_ID?: string;

  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  CLOUD_TELEGRAM_BOT_TOKEN?: string;
  CLOUD_TELEGRAM_BOT_USERNAME?: string;
  CLOUD_TELEGRAM_WEBHOOK_SECRET?: string;

  /** Only for local development: enables /auth/dev?email=... */
  DEV_LOGIN?: string;

  [key: string]: unknown;
}

export interface RequestContext {
  request: Request;
  env: Env;
  params: Record<string, string>;
  waitUntil: (p: Promise<unknown>) => void;
}
