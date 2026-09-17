// Publishes the installer at https://vigilops.cloud/install.sh
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'public'), { recursive: true });
copyFileSync(resolve(root, '../install.sh'), resolve(root, 'public/install.sh'));
console.log('copied install.sh to public/');
