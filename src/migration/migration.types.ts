
export type SourceType = 'aws' | 'gcp' | 'azure' | 'digital-ocean' | 'linode' | 'existing-vps';
export type TargetType = 'contabo' | 'linode' | 'digital-ocean' | 'self-hosted-vps';
export type MigrationType = 'docker' | 'kubernetes' | 'managed-database' | 'object-storage' | 'vm-snapshot';

export type MigrationStatus = 'planning' | 'validated' | 'dry-run-passed' | 'in-progress' | 'completed' | 'failed' | 'rolled-back';
export type MigrationPhase = 1 | 2 | 3 | 4 | 5;
export type AppStatus = 'pending' | 'transferring' | 'validating' | 'live' | 'failed' | 'rolled-back';

export interface MigrationPlan {
  id: string;
  name: string;
  description?: string;

  sourceType: SourceType;
  targetType: TargetType;
  targetVpsIp: string;
  targetVpsSshKey: string;

  apps: MigrationApp[];

  currentPhase: MigrationPhase;
  status: MigrationStatus;
  startedAt?: Date;
  completedAt?: Date;

  errors: MigrationError[];
  checkpoints: MigrationCheckpoint[];
  completedApps: number;

  cutoverDate?: Date;
  rollbackWindowHours: number;
  parallelAppsLimit: number;
  enableAutoRollback: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export interface MigrationApp {
  name: string;
  type: MigrationType;
  sourceId: string;
  targetId?: string;

  estimatedSizeGb: number;
  estimatedTransferMinutes: number;

  status: AppStatus;
  dataTransferred?: number;
  validationResults?: ValidationResult[];

  healthCheckUrl?: string;
  healthCheckInterval?: number;

  dockerConfig?: DockerMigrationConfig;
  databaseConfig?: DatabaseMigrationConfig;
  storageConfig?: StorageMigrationConfig;

  dependsOn?: string[];

  rollbackPoint?: string;
  lastValidationAt?: Date;
}

export interface DockerMigrationConfig {
  sourceRegistry: string;
  sourceImageTag: string;
  targetRegistry: string;
  targetImageTag: string;
  ports?: { [key: string]: number };
  env?: { [key: string]: string };
  volumes?: string[];
  restartPolicy?: 'no' | 'always' | 'on-failure';
}

export interface DatabaseMigrationConfig {
  sourceType: 'rds' | 'self-managed' | 'managed';
  sourceEndpoint: string;
  sourcePort: number;
  sourceDatabase: string;
  targetEndpoint: string;
  targetPort: number;
  targetDatabase: string;
  transferMethod: 'mysqldump' | 'pg_dump' | 'backup-restore' | 'replication';
  backupPath?: string;
}

export interface StorageMigrationConfig {
  sourceBucket: string;
  sourceRegion: string;
  targetPath: string;
  transferMethod: 's3-sync' | 'aws-datamove' | 'manual-copy';
  preservePermissions: boolean;
}

export interface ValidationResult {
  checkName: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  executedAt: Date;
}

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

export interface MigrationCheckpoint {
  id: string;
  phase: MigrationPhase;
  app?: string;
  timestamp: Date;
  status: 'success' | 'warning' | 'failed';
  message: string;

  rollbackCommand?: string;
  rollbackData?: Record<string, unknown>;

  duration: number;
  resource?: string;
}

export interface MigrationProgress {
  migrationId: string;
  phase: MigrationPhase;
  totalApps: number;
  completedApps: number;
  currentApp?: string;
  appProgress: number;
  overallProgress: number;

  elapsedSeconds: number;
  estimatedRemainingSeconds: number;

  message: string;
  lastUpdate: Date;

  errors?: string[];
  warnings?: string[];
}

export interface MigrationConfig {
  name: string;
  description?: string;

  source: {
    type: SourceType;
    credentials?: Record<string, string>;
  };

  target: {
    type: TargetType;
    ip: string;
    sshKey: string;
    sshUser?: string;
  };

  apps: Array<{
    name: string;
    type: MigrationType;
    sourceId: string;
    config?: Record<string, unknown>;
  }>;

  options?: {
    parallelAppsLimit?: number;
    rollbackWindowHours?: number;
    enableAutoRollback?: boolean;
    dryRunFirst?: boolean;
  };
}

export interface ValidationReport {
  timestamp: Date;
  target: 'source' | 'target';
  passed: boolean;
  checks: ValidationResult[];
  warnings: string[];
  blockers: string[];
  estimatedReadiness: number;
}

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
