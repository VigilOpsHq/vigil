/**
 * CLI Commands for Vigil
 * Usage: vigil <command> [options]
 */

import { collect, getContainers, getContainerLogs, getDisk, getMemory, getNginx, getHealthChecks } from '../collector';
import { execute, isSafeCommand } from '../executor';
import { deploy, listApps } from '../deploy/deployer';
import { info, error } from '../logger';
import readline from 'readline';
import { BACKUP_DIR, backupAndNotify, detectDatabase, formatSize, listBackups, parseBackupFile, restore } from '../backup/engine';
import { describeSchedule, loadSchedules, removeSchedule, setSchedule } from '../backup/schedule';
import { currentVersion, isNewer, latestRelease } from '../update';

export interface CLICommand {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[]) => Promise<void>;
}

/**
 * status - Full system snapshot
 */
export const statusCommand: CLICommand = {
  name: 'status',
  description: 'Full system snapshot (containers, disk, memory, nginx, health)',
  usage: 'vigil status',
  handler: async () => {
    const snapshot = await collect();

    console.log('\n📊 VIGIL STATUS\n');

    // Containers
    console.log('🐳 CONTAINERS');
    if (snapshot.containers.length === 0) {
      console.log('   (none)');
    } else {
      snapshot.containers.forEach((c) => {
        const icon = c.state === 'running' ? '🟢' : '🔴';
        console.log(`   ${icon} ${c.name.padEnd(30)} [${c.state}] ${c.status}`);
      });
    }

    // Disk
    console.log('\n💾 DISK');
    const diskIcon = snapshot.disk.usedPercent >= 85 ? '⚠️ ' : '✅';
    console.log(`   ${diskIcon}${snapshot.disk.usedPercent}% used (${snapshot.disk.used} / ${snapshot.disk.total})`);
    console.log(`      Free: ${snapshot.disk.available}`);

    // Memory
    console.log('\n🧠 MEMORY');
    const memIcon = snapshot.memory.usedPercent >= 90 ? '⚠️ ' : '✅';
    console.log(`   ${memIcon}${snapshot.memory.usedPercent}% used (${snapshot.memory.usedMb}MB / ${snapshot.memory.totalMb}MB)`);
    console.log(`      Free: ${snapshot.memory.freeMb}MB`);

    // Nginx
    console.log('\n🌐 NGINX');
    const nginxIcon = snapshot.nginx.running ? '🟢' : '🔴';
    console.log(`   ${nginxIcon} ${snapshot.nginx.running ? 'Running' : 'NOT RUNNING'}`);

    // Health checks
    if (snapshot.healthChecks.length > 0) {
      console.log('\n❤️ HEALTH CHECKS');
      snapshot.healthChecks.forEach((h) => {
        const icon = h.healthy ? '🟢' : '🔴';
        console.log(`   ${icon} ${h.url}`);
        console.log(`      Status: ${h.statusCode ?? 'no response'} | Response: ${h.responseTimeMs}ms`);
      });
    }

    console.log('\n');
  },
};

/**
 * containers - List containers
 */
export const containersCommand: CLICommand = {
  name: 'containers',
  description: 'List all Docker containers',
  usage: 'vigil containers',
  handler: async () => {
    const containers = await getContainers();

    console.log('\n🐳 CONTAINERS\n');
    if (containers.length === 0) {
      console.log('   (none)');
    } else {
      containers.forEach((c) => {
        const icon = c.state === 'running' ? '🟢' : '🔴';
        console.log(`   ${icon} ${c.name.padEnd(30)} [${c.state}]`);
        console.log(`      ID: ${c.id}`);
        console.log(`      Status: ${c.status}`);
        console.log(`      Running for: ${c.runningFor}\n`);
      });
    }
  },
};

/**
 * logs - Get container logs
 */
export const logsCommand: CLICommand = {
  name: 'logs',
  description: 'Get logs from a container',
  usage: 'vigil logs <container-name> [lines]',
  handler: async (args) => {
    if (args.length === 0) {
      console.error('❌ Usage: vigil logs <container-name> [lines]');
      process.exit(1);
    }

    const containerName = args[0];
    const lines = parseInt(args[1] ?? '50', 10);

    console.log(`\n📋 Logs from ${containerName} (last ${lines} lines)\n`);

    const result = await getContainerLogs(containerName, lines);
    console.log(result.logs || '(no logs)');
    console.log('');
  },
};

/**
 * restart - Restart a container
 */
export const restartCommand: CLICommand = {
  name: 'restart',
  description: 'Restart a Docker container',
  usage: 'vigil restart <container-name>',
  handler: async (args) => {
    if (args.length === 0) {
      console.error('❌ Usage: vigil restart <container-name>');
      process.exit(1);
    }

    const containerName = args[0];
    const command = `docker restart ${containerName}`;

    if (!isSafeCommand(command)) {
      console.error(`❌ Unsafe command blocked: ${command}`);
      process.exit(1);
    }

    console.log(`\n🔄 Restarting ${containerName}...`);
    const result = await execute(command);

    if (result.success) {
      console.log(`✅ ${containerName} restarted successfully\n`);
    } else {
      console.error(`❌ Failed to restart ${containerName}: ${result.error}\n`);
      process.exit(1);
    }
  },
};

/**
 * disk - Show disk usage
 */
export const diskCommand: CLICommand = {
  name: 'disk',
  description: 'Show disk usage',
  usage: 'vigil disk',
  handler: async () => {
    const disk = await getDisk();

    console.log('\n💾 DISK USAGE\n');
    console.log(`   Total: ${disk.total}`);
    console.log(`   Used:  ${disk.used} (${disk.usedPercent}%)`);
    console.log(`   Free:  ${disk.available}\n`);

    if (disk.usedPercent >= 85) {
      console.log('   ⚠️  WARNING: Disk usage is high!\n');
    }
  },
};

/**
 * memory - Show memory usage
 */
export const memoryCommand: CLICommand = {
  name: 'memory',
  description: 'Show memory usage',
  usage: 'vigil memory',
  handler: async () => {
    const memory = await getMemory();

    console.log('\n🧠 MEMORY USAGE\n');
    console.log(`   Total: ${memory.totalMb}MB`);
    console.log(`   Used:  ${memory.usedMb}MB (${memory.usedPercent}%)`);
    console.log(`   Free:  ${memory.freeMb}MB\n`);

    if (memory.usedPercent >= 90) {
      console.log('   ⚠️  WARNING: Memory usage is high!\n');
    }
  },
};

/**
 * health - Run health checks
 */
export const healthCommand: CLICommand = {
  name: 'health',
  description: 'Run health checks on configured endpoints',
  usage: 'vigil health',
  handler: async () => {
    const checks = await getHealthChecks();

    console.log('\n❤️ HEALTH CHECKS\n');

    if (checks.length === 0) {
      console.log('   (no health checks configured)');
    } else {
      checks.forEach((check) => {
        const icon = check.healthy ? '🟢' : '🔴';
        console.log(`   ${icon} ${check.url}`);
        console.log(`      Status: ${check.statusCode ?? 'no response'}`);
        console.log(`      Response time: ${check.responseTimeMs}ms\n`);
      });
    }
  },
};

/**
 * apps - List deployable apps
 */
export const appsCommand: CLICommand = {
  name: 'apps',
  description: 'List apps registered for deployment',
  usage: 'vigil apps',
  handler: async () => {
    const apps = listApps();

    console.log('\n📦 DEPLOYABLE APPS\n');
    if (apps.length === 0) {
      console.log('   (no apps registered)');
    } else {
      apps.forEach((app) => {
        console.log(`   • ${app}`);
      });
    }
    console.log('');
  },
};

/**
 * deploy - Deploy an app
 */
export const deployCommand: CLICommand = {
  name: 'deploy',
  description: 'Deploy an app',
  usage: 'vigil deploy <app-name>',
  handler: async (args) => {
    if (args.length === 0) {
      console.error('❌ Usage: vigil deploy <app-name>');
      console.error('   Run: vigil apps  (to see available apps)');
      process.exit(1);
    }

    const appName = args[0];
    const apps = listApps();

    if (!apps.includes(appName)) {
      console.error(`❌ Unknown app: ${appName}`);
      console.error(`   Available: ${apps.join(', ')}`);
      process.exit(1);
    }

    console.log(`\n🚀 Deploying ${appName}...\n`);
    const result = await deploy(appName);

    if (result.success) {
      console.log(`✅ Deploy succeeded: ${appName} (healthy in ${result.duration}s)\n`);
    } else {
      console.error(`❌ Deploy failed: ${appName}\n${result.message}\n`);
      process.exit(1);
    }
  },
};

export const backupCommand: CLICommand = {
  name: 'backup',
  description: 'Back up a database container, or manage backup schedules',
  usage: 'vigil backup <container> [database]',
  handler: async (args) => {
    const [first, ...rest] = args;

    if (first === 'schedules') {
      const schedules = loadSchedules();
      console.log('\n🗓  BACKUP SCHEDULES\n');
      if (schedules.length === 0) console.log('   (none) — add one: vigil backup schedule <container> daily 02:00');
      schedules.forEach((s) => console.log(`   • ${s.container.padEnd(30)} ${describeSchedule(s)}`));
      console.log('');
      return;
    }

    if (first === 'schedule') {
      const [container, ...spec] = rest;
      if (!container || spec.length === 0) {
        console.error('❌ Usage: vigil backup schedule <container> hourly | daily [HH:MM] | weekly [day] [HH:MM]');
        process.exit(1);
      }
      await detectDatabase(container);
      const s = setSchedule(container, spec);
      console.log(`\n🗓  ${container} will be backed up ${describeSchedule(s)} (server time)\n`);
      return;
    }

    if (first === 'unschedule') {
      if (!rest[0]) {
        console.error('❌ Usage: vigil backup unschedule <container>');
        process.exit(1);
      }
      console.log(removeSchedule(rest[0]) ? `\n🗓  Schedule removed for ${rest[0]}\n` : `\n${rest[0]} had no schedule\n`);
      return;
    }

    if (!first) {
      console.error('❌ Usage: vigil backup <container> [database]');
      console.error('   Example: vigil backup songdis-postgres');
      process.exit(1);
    }

    console.log(`\n⏳ Backing up ${first}...`);
    const r = await backupAndNotify(first, rest[0]);
    console.log(`✅ Saved ${r.path} (${formatSize(r.sizeBytes)}, ${Math.round(r.durationMs / 1000)}s)`);
    console.log(`   Copies: server disk${r.offsite.length ? ', ' + r.offsite.join(', ') : ' only'}\n`);
  },
};

export const backupsCommand: CLICommand = {
  name: 'backups',
  description: 'List backups stored on this server',
  usage: 'vigil backups [container]',
  handler: async (args) => {
    const files = listBackups(args[0]);
    console.log(`\n🗄  BACKUPS in ${BACKUP_DIR}\n`);
    if (files.length === 0) console.log('   (none)');
    files.forEach((b) => console.log(`   ${b.file}\n      ${formatSize(b.sizeBytes)} — ${b.createdAt.toLocaleString()}`));
    console.log('');
  },
};

export const restoreCommand: CLICommand = {
  name: 'restore',
  description: 'Restore a database from a backup file',
  usage: 'vigil restore <file> [container] [--yes]',
  handler: async (args) => {
    const yes = args.includes('--yes');
    const [file, container] = args.filter((a) => a !== '--yes');
    if (!file) {
      console.error('❌ Usage: vigil restore <file> [container] [--yes]');
      console.error('   See files: vigil backups');
      process.exit(1);
    }

    const parsed = parseBackupFile(file);
    const target = container ?? parsed.container;

    if (!yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) =>
        rl.question(`⚠️  This will OVERWRITE database "${parsed.database}" in ${target}. Type "yes" to continue: `, resolve)
      );
      rl.close();
      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('Cancelled.');
        return;
      }
    }

    console.log(`\n⏳ Taking a safety backup, then restoring ${file} into ${target}...`);
    const { safetyBackup } = await restore(file, container);
    console.log(`✅ Restore complete. Previous data saved as ${safetyBackup}\n`);
  },
};

export const versionCommand: CLICommand = {
  name: 'version',
  description: 'Show the running version and check for updates',
  usage: 'vigil version',
  handler: async () => {
    const current = currentVersion();
    console.log(`\nVigilOps ${current}`);
    try {
      const latest = await latestRelease();
      console.log(
        isNewer(latest.version, current)
          ? `⬆️  ${latest.version} is available — run: vigil update\n   ${latest.url}\n`
          : '✅ Up to date\n'
      );
    } catch (err) {
      console.log(`(couldn't check for updates: ${err instanceof Error ? err.message : String(err)})\n`);
    }
  },
};

/**
 * help - Show help
 */
export const helpCommand: CLICommand = {
  name: 'help',
  description: 'Show help',
  usage: 'vigil help',
  handler: async () => {
    console.log(`
🤖 VIGIL - Server Assistant

USAGE:
  vigil <command> [options]

COMMANDS:
  status              Full system snapshot
  containers          List all containers
  logs <name>         Get logs from container
  restart <name>      Restart a container
  disk                Show disk usage
  memory              Show memory usage
  health              Run health checks
  apps                List deployable apps
  deploy <app>        Deploy an app
  version             Show version and check for updates
  help                Show this help

SERVICE:
  start               Start the Vigil service
  stop                Stop the Vigil service
  update              Update Vigil to the newest version

BACKUPS:
  backup <container> [db]                 Back up a database now
  backups [container]                     List backups on this server
  restore <file> [container] [--yes]      Restore a backup (safety backup taken first)
  backup schedule <container> daily 02:00 Schedule backups (hourly | daily | weekly sun 03:00)
  backup unschedule <container>           Remove a schedule
  backup schedules                        List schedules

EXAMPLES:
  vigil status
  vigil restart api
  vigil logs api 100
  vigil deploy myapp
  vigil disk
  vigil health

More info: https://github.com/yourorg/vigil
`);
  },
};

export const commands: CLICommand[] = [
  statusCommand,
  containersCommand,
  logsCommand,
  restartCommand,
  diskCommand,
  memoryCommand,
  healthCommand,
  appsCommand,
  deployCommand,
  backupCommand,
  backupsCommand,
  restoreCommand,
  versionCommand,
  helpCommand,
];

export function getCommand(name: string): CLICommand | undefined {
  return commands.find((c) => c.name === name);
}
