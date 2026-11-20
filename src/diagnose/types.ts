/** What Vigil could learn about one container without changing anything. */
export interface Evidence {
  container: string;
  /** running, restarting, exited, dead, … */
  state: string;
  exitCode: number | null;
  oomKilled: boolean;
  restartCount: number;
  restartPolicy: string;
  image: string;
  /** CPU architecture the image was built for (amd64, arm64…), when known. */
  imageArch: string | null;
  /** CPU architecture of this server. */
  hostArch: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Docker's own error for the last start (e.g. "exec format error"). */
  dockerError: string | null;
  /** Container memory limit in MB, 0 = no limit. */
  memoryLimitMb: number;
  /** Names of the environment variables set in the container. Values are never collected. */
  envNames: string[];
  entrypoint: string[];
  /** The start script's first line ends in \r (Windows line endings). null = not checked / no script. */
  entrypointCrlf: boolean | null;
  /** Log lines of the latest start (or the whole tail when it doesn't loop), secrets redacted. */
  lastCycle: string[];
  /** The log tail, secrets redacted. */
  logTail: string[];
  /** Distinct error lines in the latest start, in order. The first one is usually the cause. */
  errors: string[];
  /** Files added or changed inside the container since it was created (docker diff). */
  changedFiles: string[];
  /** Sizes of the changed files that are worth a look (caches, configs), path → bytes. */
  fileSizes: Record<string, number>;
  /** Steps that could not be completed, so the report can say what it doesn't know. */
  gaps: string[];
}

export interface Finding {
  /** Playbook id, e.g. laravel-empty-cache. */
  id: string;
  /** One line: what is wrong. */
  title: string;
  /** Why it breaks, in plain words. */
  cause: string;
  /** The facts that point to it. */
  evidence: string[];
  /** How to get the server back now. */
  fixNow: string[];
  /** Shell commands for the operator, in order. Vigil does not run these on its own. */
  commands?: string[];
  /** What to change in the code or Dockerfile so it doesn't happen again. */
  permanentFix: string;
  /** Whether restarting the container can help. Most crash causes survive a restart. */
  restartHelps: boolean;
  confidence: 'high' | 'medium';
}

export interface Diagnosis {
  id: string;
  host: string;
  createdAt: string;
  evidence: Evidence;
  /** Best match first. Empty when no playbook recognised the problem. */
  findings: Finding[];
  /** What else is wrong on the server at the same time (health checks, disk…). */
  context: string[];
}
