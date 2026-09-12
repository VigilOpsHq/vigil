/**
 * Example Migration Configuration
 * Copy to migration.config.ts and fill in your AWS/Contabo details
 */

import { MigrationConfig } from './migration.types';

/**
 * Example 1: Simple Docker app migration
 */
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
    ip: '192.168.1.100', // Your Contabo VPS IP
    sshKey: '/home/user/.ssh/contabo-key.pem',
    sshUser: 'root',
  },

  apps: [
    {
      name: 'api-server',
      type: 'docker',
      sourceId: 'i-0123456789abcdef', // AWS EC2 instance ID
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

/**
 * Example 2: Multi-tier migration (API + Database + Storage)
 */
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
    // First: API service (no dependencies)
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
        volumes: ['/data:/app/data'], // Mount persistent data
        restartPolicy: 'always',
      },
    },

    // Second: PostgreSQL database (must wait for API to be ready)
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
        transferMethod: 'backup-restore', // RDS automated backup
        backupPath: 's3://my-backups/prod-db-2024-09-12.sql',
      },
    },

    // Third: S3 storage (independent, can run parallel)
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
    parallelAppsLimit: 3, // Can transfer DB and storage simultaneously
    rollbackWindowHours: 6,
    enableAutoRollback: true,
    dryRunFirst: true,
  },
};

/**
 * Example 3: Kubernetes to Docker migration
 * (K8s deployment → docker-compose on Contabo)
 */
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
    parallelAppsLimit: 3, // All services can migrate in parallel
    rollbackWindowHours: 2, // Quick turnaround
    enableAutoRollback: true,
    dryRunFirst: true,
  },
};

/**
 * How to use these configs:
 *
 * 1. Via MCP from Claude/Cursor:
 *    create_migration_plan {
 *      name: "Full Stack Migration"
 *      source: "aws"
 *      target_ip: "192.168.1.100"
 *      target_ssh_key: "/path/to/key.pem"
 *      apps: [...]
 *    }
 *
 * 2. Via CLI (future):
 *    vigilops migrate plan --config ./src/migration/migration.config.ts --preset multi-tier
 *
 * 3. Programmatically:
 *    import { multiTierMigration } from './migration.config';
 *    const plan = await createMigrationPlan(multiTierMigration);
 *
 * Then execute:
 *    await validateSource(plan);
 *    await validateTarget(plan);
 *    await runDryRun(plan);
 *    await executeMigrationPhase(plan, 1);  // Setup
 *    await executeMigrationPhase(plan, 2);  // Data
 *    await executeMigrationPhase(plan, 3);  // Validate
 *    await executeMigrationPhase(plan, 4);  // Cutover (requires approval)
 *    await executeMigrationPhase(plan, 5);  // Rollback standby
 */
