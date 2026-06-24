/**
 * SeaweedFS 客户端（Apache 2.0, 完整 S3 API 兼容）
 * 用于用户文件桶管理、预签名上传/下载 URL
 */

import { Client as MinioClient } from 'minio';

// ─── 配置 ───

export interface SeaweedFSConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
}

// ─── 文件信息 ───

export interface FileInfo {
  name: string;
  size: number;
  lastModified: Date;
}

// ─── 客户端接口 ───

export interface SeaweedFSClient {
  createUserBucket(userId: string): Promise<void>;
  presignUpload(userId: string, filename: string, expiresSeconds?: number): Promise<string>;
  presignDownload(userId: string, filename: string, expiresSeconds?: number): Promise<string>;
  removeFile(userId: string, filename: string): Promise<void>;
  listFiles(userId: string, prefix?: string): Promise<FileInfo[]>;
}

// ─── 创建客户端 ───

function getBucketName(userId: string): string {
  // SeaweedFS/S3 桶名规范：小写字母、数字、连字符，3-63 字符
  return `agent-${userId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
}

export function createSeaweedFS(config: SeaweedFSConfig): SeaweedFSClient {
  const mc = new MinioClient({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });

  return {
    async createUserBucket(userId) {
      const bucket = getBucketName(userId);
      const exists = await mc.bucketExists(bucket);
      if (!exists) {
        await mc.makeBucket(bucket);
      }
    },

    async presignUpload(userId, filename, expiresSeconds = 3600) {
      const bucket = getBucketName(userId);
      return mc.presignedPutObject(bucket, filename, expiresSeconds);
    },

    async presignDownload(userId, filename, expiresSeconds = 3600) {
      const bucket = getBucketName(userId);
      return mc.presignedGetObject(bucket, filename, expiresSeconds);
    },

    async removeFile(userId, filename) {
      const bucket = getBucketName(userId);
      await mc.removeObject(bucket, filename);
    },

    async listFiles(userId, prefix) {
      const bucket = getBucketName(userId);
      const stream = mc.listObjects(bucket, prefix, true);
      const files: FileInfo[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (obj) => {
          if (obj.name && obj.size !== undefined && obj.lastModified) {
            files.push({
              name: obj.name,
              size: obj.size,
              lastModified: obj.lastModified,
            });
          }
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(files));
      });
    },
  };
}
