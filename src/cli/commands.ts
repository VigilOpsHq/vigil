/**
 * CLI Commands for Vigil
 * Usage: vigil <command> [options]
 */

import { collect, getContainers, getContainerLogs, getDisk, getMemory, getNginx, getHealthChecks } from '../collector';
import { execute, isSafeCommand } from '../executor';
import { deploy, listApps } from '../deploy/deployer';
import { info, error } from '../logger';

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
  help                Show this help

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
  helpCommand,
];

export function getCommand(name: string): CLICommand | undefined {
  return commands.find((c) => c.name === name);
}
