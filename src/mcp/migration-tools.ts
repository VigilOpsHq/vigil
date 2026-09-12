/**
 * MCP Tools for Migration Orchestration
 * Allows Claude/Cursor/any MCP client to orchestrate AWS → Contabo migrations
 */

import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { info, error } from '../logger';
import {
  createMigrationPlan,
  validateSource,
  validateTarget,
  runDryRun,
  executeMigrationPhase,
  rollbackMigration,
  getMigrationProgress,
  getMigrationHistory,
} from '../migration/migration.engine';
import { MigrationConfig, MigrationPlan } from '../migration/migration.types';

// In-memory store for active migrations (in production, use persistent storage)
const activeMigrations = new Map<string, MigrationPlan>();

export function registerMigrationTools(server: McpServer): void {
  /**
   * Tool 1: Create migration plan
   */
  server.registerTool(
    'create_migration_plan',
    {
      description:
        'Create a detailed migration plan from AWS/GCP to Contabo VPS. Uses AI to analyze dependencies and optimize phases.',
      inputSchema: {
        name: z.string().describe('Name of the migration'),
        source: z.enum(['aws', 'gcp', 'azure']).describe('Source cloud provider'),
        target_ip: z.string().describe('Contabo VPS IP address'),
        target_ssh_key: z.string().describe('Path to SSH private key for target VPS'),
        apps: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(['docker', 'kubernetes', 'managed-database', 'object-storage']),
              source_id: z.string().describe('AWS instance ID, RDS endpoint, S3 bucket, etc.'),
            })
          )
          .describe('Applications/services to migrate'),
      },
    },
    async ({ name, source, target_ip, target_ssh_key, apps }) => {
      info(`[mcp] create_migration_plan: ${name} (${apps.length} apps)`);

      const config: MigrationConfig = {
        name,
        source: { type: source as any },
        target: { type: 'contabo', ip: target_ip, sshKey: target_ssh_key },
        apps: apps.map((a) => ({ ...a, sourceId: a.source_id })),
      };

      const plan = await createMigrationPlan(config);
      if (!plan) {
        return {
          content: [
            {
              type: 'text',
              text: 'Failed to create migration plan. Check logs for details.',
            },
          ],
        };
      }

      activeMigrations.set(plan.id, plan);

      return {
        content: [
          {
            type: 'text',
            text: `Migration plan created: ${plan.id}\n\nPlan Summary:\n- Status: ${plan.status}\n- Apps: ${plan.apps.length}\n- Phases: 5\n- Estimated duration: ~${plan.apps.reduce((sum, a) => sum + (a.estimatedTransferMinutes || 30), 0)} minutes\n\nNext step: /validate_migration_source ${plan.id}`,
          },
        ],
      };
    }
  );

  /**
   * Tool 2: Validate source infrastructure
   */
  server.registerTool(
    'validate_migration_source',
    {
      description: 'Health-check the source infrastructure (AWS) before migration. Verifies backups, connectivity, permissions.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
      },
    },
    async ({ migration_id }) => {
      info(`[mcp] validate_migration_source: ${migration_id}`);

      const plan = activeMigrations.get(migration_id);
      if (!plan) {
        return {
          content: [{ type: 'text', text: `Migration ${migration_id} not found.` }],
        };
      }

      const report = await validateSource(plan);
      if (!report) {
        return {
          content: [{ type: 'text', text: 'Validation failed. Check logs.' }],
        };
      }

      const summary = `Source Validation: ${report.passed ? '✅ PASSED' : '❌ FAILED'}\n\nChecks:\n${report.checks
        .map((c) => `  ${c.passed ? '✅' : '❌'} ${c.checkName}: ${c.message}`)
        .join('\n')}\n\nReadiness: ${report.estimatedReadiness}%`;

      return {
        content: [{ type: 'text', text: summary }],
      };
    }
  );

  /**
   * Tool 3: Validate target VPS
   */
  server.registerTool(
    'validate_migration_target',
    {
      description: 'Health-check the target Contabo VPS. Verifies Docker, disk space, networking, SSH access.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
      },
    },
    async ({ migration_id }) => {
      info(`[mcp] validate_migration_target: ${migration_id}`);

      const plan = activeMigrations.get(migration_id);
      if (!plan) {
        return {
          content: [{ type: 'text', text: `Migration ${migration_id} not found.` }],
        };
      }

      const report = await validateTarget(plan);
      if (!report) {
        return {
          content: [{ type: 'text', text: 'Validation failed. Check logs.' }],
        };
      }

      const summary = `Target Validation: ${report.passed ? '✅ PASSED' : '❌ FAILED'}\n\nChecks:\n${report.checks
        .map((c) => `  ${c.passed ? '✅' : '❌'} ${c.checkName}: ${c.message}`)
        .join('\n')}\n\nReadiness: ${report.estimatedReadiness}%`;

      return {
        content: [{ type: 'text', text: summary }],
      };
    }
  );

  /**
   * Tool 4: Run dry-run (simulation without cutover)
   */
  server.registerTool(
    'run_migration_dry_run',
    {
      description:
        'Simulate the complete migration without switching traffic. Tests data transfer, validation, rollback — no production impact.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
      },
    },
    async ({ migration_id }) => {
      info(`[mcp] run_migration_dry_run: ${migration_id}`);

      const plan = activeMigrations.get(migration_id);
      if (!plan) {
        return {
          content: [{ type: 'text', text: `Migration ${migration_id} not found.` }],
        };
      }

      const result = await runDryRun(plan);
      if (!result) {
        return {
          content: [{ type: 'text', text: 'Dry-run failed. Check logs.' }],
        };
      }

      const summary = `Dry-Run Result: ${result.ready ? '✅ READY FOR MIGRATION' : '❌ NOT READY'}\n\nApps:\n${result.details
        .map((d) => `  ${d.app}: ${d.status === 'success' ? '✅' : '❌'} (~${d.duration}s)`)
        .join('\n')}\n\nRecommendations:\n${result.recommendations.map((r) => `  • ${r}`).join('\n')}`;

      return {
        content: [{ type: 'text', text: summary }],
      };
    }
  );

  /**
   * Tool 5: Execute migration phase
   */
  server.registerTool(
    'execute_migration_phase',
    {
      description:
        'Run one phase of the migration. Phases: 1=Setup, 2=DataTransfer, 3=Validation, 4=Cutover, 5=RollbackStandby. Phase 4 switches production traffic.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
        phase: z.enum(['1', '2', '3', '4', '5']).describe('Phase number to execute'),
        require_approval: z
          .boolean()
          .optional()
          .describe('If true, waits for /approve before running (required for phase 4)'),
      },
    },
    async ({ migration_id, phase, require_approval }) => {
      info(`[mcp] execute_migration_phase: ${migration_id} phase ${phase}`);

      const plan = activeMigrations.get(migration_id);
      if (!plan) {
        return {
          content: [{ type: 'text', text: `Migration ${migration_id} not found.` }],
        };
      }

      const phaseNum = parseInt(phase) as 1 | 2 | 3 | 4 | 5;

      if (require_approval && phaseNum === 4) {
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ Phase 4 (Cutover) will switch production traffic to Contabo. This requires approval.\n\nPending approval. Run /approve_migration_phase_4 ${migration_id} to proceed.`,
            },
          ],
        };
      }

      plan.currentPhase = phaseNum;
      const success = await executeMigrationPhase(plan, phaseNum);

      const message = success
        ? `✅ Phase ${phaseNum} completed successfully`
        : `❌ Phase ${phaseNum} failed. Check logs for details.`;

      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    }
  );

  /**
   * Tool 6: Monitor migration progress
   */
  server.registerTool(
    'monitor_migration',
    {
      description: 'Get real-time progress on an in-flight migration. Shows current phase, completion %, errors.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
      },
    },
    async ({ migration_id }) => {
      info(`[mcp] monitor_migration: ${migration_id}`);

      const plan = activeMigrations.get(migration_id);
      if (!plan) {
        return {
          content: [{ type: 'text', text: `Migration ${migration_id} not found.` }],
        };
      }

      const progress = getMigrationProgress(plan);

      const summary = `Migration Progress: ${progress.overallProgress}%\n\nPhase: ${progress.phase}/5\nApps: ${progress.completedApps}/${progress.totalApps} completed\nElapsed: ${Math.floor(progress.elapsedSeconds / 60)}m\nEstimated remaining: ${Math.floor(progress.estimatedRemainingSeconds / 60)}m\n\n${progress.message}`;

      return {
        content: [{ type: 'text', text: summary }],
      };
    }
  );

  /**
   * Tool 7: Rollback migration
   */
  server.registerTool(
    'rollback_migration',
    {
      description:
        'Abort the migration and return to source infrastructure. Can rollback to a specific phase or all the way back.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
        to_phase: z
          .enum(['1', '2', '3', '4'])
          .optional()
          .describe('Rollback to this phase. If omitted, rolls back completely.'),
      },
    },
    async ({ migration_id, to_phase }) => {
      info(`[mcp] rollback_migration: ${migration_id}${to_phase ? ` to phase ${to_phase}` : ''}`);

      const plan = activeMigrations.get(migration_id);
      if (!plan) {
        return {
          content: [{ type: 'text', text: `Migration ${migration_id} not found.` }],
        };
      }

      const success = await rollbackMigration(plan, to_phase ? (parseInt(to_phase) as any) : undefined);

      const message = success
        ? `✅ Rollback complete. Traffic restored to source infrastructure.`
        : `❌ Rollback failed. Check logs.`;

      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    }
  );

  /**
   * Tool 8: Get migration history
   */
  server.registerTool(
    'get_migration_history',
    {
      description: 'View the audit trail of a migration: all phases, actions, errors, checkpoints.',
      inputSchema: {
        migration_id: z.string().describe('Migration plan ID'),
        limit: z.number().optional().describe('Max entries to return (default: 50)'),
      },
    },
    async ({ migration_id, limit }) => {
      info(`[mcp] get_migration_history: ${migration_id}`);

      const history = getMigrationHistory(migration_id, limit ?? 50);
      if (history.length === 0) {
        return {
          content: [{ type: 'text', text: 'No migration history found.' }],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Migration History (${history.length} entries):\n\n${history
              .map(
                (h) => `${new Date(h.timestamp as string).toLocaleTimeString()}: ${h.type ?? 'event'}${h.phase ? ` [Phase ${h.phase}]` : ''}`
              )
              .join('\n')}`,
          },
        ],
      };
    }
  );

  info('[mcp] 8 migration orchestration tools registered');
}
