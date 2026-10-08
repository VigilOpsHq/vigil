
import { MigrationConfig } from './migration.types';

export const simpleDockerMigration: MigrationConfig = {
  name: 'API Server Migration — AWS → Contabo',
  description: 'Moving Node.js API service from AWS EC2 to Contabo VPS',

  source: {
    type: 'aws',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      region: 'us-east-1',
    },
  },

  target: {
    type: 'contabo',
    ip: '192.168.1.100',
    sshKey: '/home/user/.ssh/contabo-key.pem',
    sshUser: 'root',
  },

  apps: [
    {
      name: 'api-server',
      type: 'docker',
      sourceId: 'i-0123456789abcdef',
      config: {
        sourceRegistry: 'ghcr.io/myorg',
        sourceImageTag: 'api:latest',
        targetRegistry: 'ghcr.io/myorg',
        targetImageTag: 'api:latest',
        ports: {
          '8080/tcp': 8080,
        },
        env: {
          NODE_ENV: 'production',
          DATABASE_URL: 'postgres://localhost/prod',
        },
      },
    },
  ],

  options: {
    parallelAppsLimit: 1,
    rollbackWindowHours: 4,
    enableAutoRollback: true,
    dryRunFirst: true,
  },
};

export const multiTierMigration: MigrationConfig = {
  name: 'Full Stack Migration — AWS → Contabo',
  description: 'Moving entire production stack: API, Database, and Static Files',

  source: {
    type: 'aws',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      region: 'us-east-1',
    },
  },

  target: {
    type: 'contabo',
    ip: '192.168.1.100',
    sshKey: '/home/user/.ssh/contabo-key.pem',
  },

  apps: [
    {
      name: 'api-server',
      type: 'docker',
      sourceId: 'i-0123456789abcdef',
      config: {
        sourceRegistry: 'ghcr.io/myorg',
        sourceImageTag: 'api:v2.1.0',
        targetRegistry: 'ghcr.io/myorg',
        targetImageTag: 'api:v2.1.0',
        ports: {
          '8080/tcp': 8080,
        },
        volumes: ['/data:/app/data'],
        restartPolicy: 'always',
      },
    },

    {
      name: 'postgres-primary',
      type: 'managed-database',
      sourceId: 'prod-db.c9akciq32.us-east-1.rds.amazonaws.com:5432',
      config: {
        sourceType: 'rds',
        sourceEndpoint: 'prod-db.c9akciq32.us-east-1.rds.amazonaws.com',
        sourcePort: 5432,
        sourceDatabase: 'production',
        targetEndpoint: 'localhost',
        targetPort: 5432,
        targetDatabase: 'production',
        transferMethod: 'backup-restore',
        backupPath: 's3://my-backups/prod-db-2024-09-12.sql',
      },
    },

    {
      name: 'static-files',
      type: 'object-storage',
      sourceId: 'my-production-bucket',
      config: {
        sourceBucket: 'my-production-bucket',
        sourceRegion: 'us-east-1',
        targetPath: '/mnt/storage/static',
        transferMethod: 's3-sync',
        preservePermissions: true,
      },
    },
  ],

  options: {
    parallelAppsLimit: 3,
    rollbackWindowHours: 6,
    enableAutoRollback: true,
    dryRunFirst: true,
  },
};

export const k8sToDockerMigration: MigrationConfig = {
  name: 'Kubernetes to Docker — Cost Optimization',
  description: 'Consolidating microservices from EKS to single Contabo VPS with docker-compose',

  source: {
    type: 'aws',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      region: 'us-east-1',
      eksCluster: 'prod-cluster',
    },
  },

  target: {
    type: 'contabo',
    ip: '192.168.1.100',
    sshKey: '/home/user/.ssh/contabo-key.pem',
  },

  apps: [
    {
      name: 'auth-service',
      type: 'docker',
      sourceId: 'prod-cluster:auth-service',
      config: {
        sourceRegistry: 'ecr.aws/myorg',
        sourceImageTag: 'auth-service:1.2.3',
        targetRegistry: 'docker.io/myorg',
        targetImageTag: 'auth-service:1.2.3',
        ports: {
          '3000/tcp': 3000,
        },
        env: {
          SERVICE_NAME: 'auth-service',
          LOG_LEVEL: 'info',
        },
        volumes: ['/data/auth:/app/data'],
      },
    },
    {
      name: 'payment-service',
      type: 'docker',
      sourceId: 'prod-cluster:payment-service',
      config: {
        sourceRegistry: 'ecr.aws/myorg',
        sourceImageTag: 'payment-service:2.0.1',
        targetRegistry: 'docker.io/myorg',
        targetImageTag: 'payment-service:2.0.1',
        ports: {
          '3001/tcp': 3001,
        },
      },
    },
    {
      name: 'notification-service',
      type: 'docker',
      sourceId: 'prod-cluster:notification-service',
      config: {
        sourceRegistry: 'ecr.aws/myorg',
        sourceImageTag: 'notification-service:1.5.0',
        targetRegistry: 'docker.io/myorg',
        targetImageTag: 'notification-service:1.5.0',
        ports: {
          '3002/tcp': 3002,
        },
      },
    },
  ],

  options: {
    parallelAppsLimit: 3,
    rollbackWindowHours: 2,
    enableAutoRollback: true,
    dryRunFirst: true,
  },
};
