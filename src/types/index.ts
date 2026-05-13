
export interface ContainerStatus {
  name: string;
  id: string;
  state: string; // running | exited | unhealthy | restarting | paused
  status: string; // human-readable e.g. "Up 2 hours"
  runningFor: string;
}

export interface DiskStatus {
  usedPercent: number;
  used: string;
  available: string;
  total: string;
}

export interface MemoryStatus {
  usedPercent: number;
  usedMb: number;
  totalMb: number;
  freeMb: number;
}

export interface NginxStatus {
  running: boolean;
}

export interface HealthCheckResult {
  url: string;
  statusCode: number | null;
  healthy: boolean;
  responseTimeMs: number;
}

export interface SystemSnapshot {
  timestamp: Date;
  containers: ContainerStatus[];
  disk: DiskStatus;
  memory: MemoryStatus;
  nginx: NginxStatus;
  healthChecks: HealthCheckResult[];
}


export type ActionTier = 'auto' | 'suggest' | 'alert';

export interface RuleAction {
  tier: ActionTier;
  commands: string[];
  message: string;
  ruleId: string;
}

export interface RuleMatch {
  matched: boolean;
  action?: RuleAction;
}

export interface Rule {
  id: string;
  description: string;
  condition: (snapshot: SystemSnapshot, history: RestartHistory) => boolean;
  action: (snapshot: SystemSnapshot) => RuleAction;
}


export interface RestartHistory {
  [containerName: string]: number[]; // unix timestamps of restarts
}


export type AIDecision =
  | { type: 'AUTO_FIX'; command: string; message: string; reasoning: string }
  | { type: 'SUGGEST'; command: string; message: string; reasoning: string }
  | { type: 'ALERT'; message: string; reasoning: string };


export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}


export interface PendingApproval {
  id: string;
  commands: string[];
  message: string;
  snapshot: SystemSnapshot;
  createdAt: Date;
  timeoutHandle: ReturnType<typeof setTimeout>;
}


export type AuditTrigger = 'rule' | 'ai' | 'manual' | 'approval';
export type AuditResult = 'success' | 'failed' | 'pending_approval' | 'denied' | 'alert' | 'timeout';

export interface AuditEntry {
  timestamp: string;
  trigger: AuditTrigger;
  ruleId?: string;
  action?: string;
  result: AuditResult;
  message: string;
}
