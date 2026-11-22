#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entryUrl = await import.meta.resolve('@wondelai/harness-audit');
const cliPath = join(dirname(fileURLToPath(entryUrl)), 'cli.js');
await import(pathToFileURL(cliPath).href);
