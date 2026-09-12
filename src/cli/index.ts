/**
 * Vigil CLI Entry Point
 * Run as: node dist/cli/index.js <command> [options]
 * Or: vigil <command> [options]
 */

import { getCommand } from './commands';
import { error } from '../logger';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    const { helpCommand } = await import('./commands');
    await helpCommand.handler([]);
    return;
  }

  const commandName = args[0];
  const commandArgs = args.slice(1);

  const command = getCommand(commandName);

  if (!command) {
    console.error(`❌ Unknown command: ${commandName}`);
    console.error(`\nRun: vigil help`);
    process.exit(1);
  }

  try {
    await command.handler(commandArgs);
  } catch (err) {
    error(`Command failed: ${commandName}`, err);
    console.error(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
