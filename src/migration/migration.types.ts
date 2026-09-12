/**
 * Migration orchestration types for AWS → Contabo (or any cloud) migrations
 */

export type SourceType = 'aws' | 'gcp' | 'azure' | 'digital-ocean' | 'linode' | 'existing-vps';
export type TargetType = 'contabo' | 'linode' | 'digital-ocean' | 'self-hosted-vps';
export type MigrationType = 'docker' | 'kubernetes' | 'managed-database' | 'object-storage' | 'vm-snapshot';

export type MigrationStatus = 'planning' | 'validated' | 'dry-run-passed' | 'in-progress' | 'completed' | 'failed' | 'rolled-back';
export type MigrationPhase = 1 | 2 | 3 | 4 | 5;
export type AppStatus = 'pending' | 'transferring' | 'validating' | 'live' | 'failed' | 'rolled-back';

/**
 * High-level migration plan with all details
 */
export interface MigrationPlan {
  id: string;
  name: string;
  description?: string;

  // Infrastructure configuration
  sourceType: SourceType;
  targetType: TargetType;
  targetVpsIp: string;
  targetVpsSshKey: string;

  // Apps to migrate
  apps: MigrationApp[];

  // Workflow status
  currentPhase: MigrationPhase;
  status: MigrationStatus;
  startedAt?: Date;
  completedAt?: Date;

  // Progress & errors
  errors: MigrationError[];
  checkpoints: MigrationCheckpoint[];
  completedApps: number;

  // Configuration
  cutoverDate?: Date;
  rollbackWindowHours: number;
  parallelAppsLimit: number;
  enableAutoRollback: boolean;

  // Metadata
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Individual app to be migrated
 */
export interface MigrationApp {
  name: string;
  type: MigrationType;
  sourceId: string; // AWS instance ID, container name, DB endpoint, etc.
  targetId?: string; // Will be assigned during migration

  // Resource estimates
  estimatedSizeGb: number;
  estimatedTransferMinutes: number;

  // Status tracking
  status: AppStatus;
  dataTransferred?: number; // bytes
  validationResults?: ValidationResult[];

  // Health checks
  healthCheckUrl?: string;
  healthCheckInterval?: number; // seconds

  // Specific configurations
  dockerConfig?: DockerMigrationConfig;
  databaseConfig?: DatabaseMigrationConfig;
  storageConfig?: StorageMigrationConfig;

  // Dependencies
  dependsOn?: string[]; // Other app names that must be migrated first

  // Metrics
  rollbackPoint?: string; // How to identify pre-migration state
  lastValidationAt?: Date;
}

/**
 * Docker container/image migration configuration
 */
export interface DockerMigrationConfig {
  sourceRegistry: string; // e.g., ghcr.io/myorg
  sourceImageTag: string;
  targetRegistry: string;
  targetImageTag: string;
  ports?: { [key: string]: number }; // "8080/tcp": 8080
  env?: { [key: string]: string };
  volumes?: string[]; // ["data:/app/data"]
  restartPolicy?: 'no' | 'always' | 'on-failure';
}

/**
 * Database migration configuration
 */
export interface DatabaseMigrationConfig {
  sourceType: 'rds' | 'self-managed' | 'managed'; // AWS RDS, self-managed DB, etc.
  sourceEndpoint: string;
  sourcePort: number;
  sourceDatabase: string;
  targetEndpoint: string;
  targetPort: number;
  targetDatabase: string;
  transferMethod: 'mysqldump' | 'pg_dump' | 'backup-restore' | 'replication';
  backupPath?: string; // Local backup file or S3 path
}

/**
 * Object storage migration configuration
 */
export interface StorageMigrationConfig {
  sourceBucket: string; // S3 bucket
  sourceRegion: string;
  targetPath: string; // Local path on Contabo VPS
  transferMethod: 's3-sync' | 'aws-datamove' | 'manual-copy';
  preservePermissions: boolean;
}

/**
 * Validation result from running checks
 */
export interface ValidationResult {
  checkName: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  executedAt: Date;
}

/**
 * Error tracking during migration
 */
export interface MigrationError {
  id: string;
  app: string;
  phase: MigrationPhase;
  error: string;
  errorCode?: string;
  stackTrace?: string;
  retryCount: number;
  recoverable: boolean;
  suggestedFix?: string;
  timestamp: Date;
}

/**
 * Checkpoint for rollback capability
 */
export interface MigrationCheckpoint {
  id: string;
  phase: MigrationPhase;
  app?: string; // If app-specific
  timestamp: Date;
  status: 'success' | 'warning' | 'failed';
  message: string;

  // Rollback information
  rollbackCommand?: string; // How to undo this checkpoint
  rollbackData?: Record<string, unknown>; // State needed for rollback

  // Metadata
  duration: number; // milliseconds
  resource?: string; // Container ID, DB name, etc.
}

/**
 * Real-time progress update during migration
 */
export interface MigrationProgress {
  migrationId: string;
  phase: MigrationPhase;
  totalApps: number;
  completedApps: number;
  currentApp?: string;
  appProgress: number; // 0-100
  overallProgress: number; // 0-100

  elapsedSeconds: number;
  estimatedRemainingSeconds: number;

  message: string;
  lastUpdate: Date;

  errors?: string[];
  warnings?: string[];
}

/**
 * Migration configuration (what user provides to start)
 */
export interface MigrationConfig {
  name: string;
  description?: string;

  source: {
    type: SourceType;
    credentials?: Record<string, string>; // AWS keys, SSH keys, etc.
  };

  target: {
    type: TargetType;
    ip: string;
    sshKey: string;
    sshUser?: string; // Default: root
  };

  apps: Array<{
    name: string;
    type: MigrationType;
    sourceId: string;
    config?: Record<string, unknown>;
  }>;

  options?: {
    parallelAppsLimit?: number; // Default: 3
    rollbackWindowHours?: number; // Default: 4
    enableAutoRollback?: boolean; // Default: true
    dryRunFirst?: boolean; // Default: true
  };
}

/**
 * Result of validation checks on source or target infrastructure
 */
export interface ValidationReport {
  timestamp: Date;
  target: 'source' | 'target';
  passed: boolean;
  checks: ValidationResult[];
  warnings: string[];
  blockers: string[];
  estimatedReadiness: number; // 0-100
}

/**
 * Dry-run results (simulated migration without actual cutover)
 */
export interface DryRunResult {
  migrationId: string;
  simulatedDurationSeconds: number;
  successfulApps: number;
  failedApps: number;
  details: {
    app: string;
    status: 'success' | 'failed';
    duration: number;
    message?: string;
  }[];
  ready: boolean;
  recommendations: string[];
}
