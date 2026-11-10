#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const CONTROL_KEYS = new Map([
  ['--fake-stdout', 'stdout'],
  ['--fake-out-text', 'outText'],
  ['--fake-exit', 'exit'],
  ['--fake-sleep', 'sleep'],
  ['--fake-session', 'session'],
  ['--fake-write', 'write'],
  ['--fake-stderr', 'stderr'],
  ['--fake-report-file', 'reportFile'],
]);

function parseArguments(argv) {
  const controls = {};
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--fake-')) {
      args.push(token);
      continue;
    }
    const key = CONTROL_KEYS.get(token);
    if (!key) {
      process.stderr.write(`fake-cli: unknown control ${token}\n`);
      process.exitCode = 64;
      return null;
    }
    if (index + 1 >= argv.length) {
      process.stderr.write(`fake-cli: missing value for ${token}\n`);
      process.exitCode = 64;
      return null;
    }
    controls[key] = argv[index + 1];
    index += 1;
  }
  return { controls, args };
}

function readStandardInput() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function collectFiles(args) {
  const files = {};
  for (const arg of args) {
    try {
      if (fs.statSync(arg).isFile()) {
        files[arg] = fs.readFileSync(arg, 'utf8');
      }
    } catch {
      // Not an existing file: leave it out of the report.
    }
  }
  return files;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed) {
    return;
  }
  const { controls, args } = parsed;
  const stdin = readStandardInput();

  if (controls.sleep !== undefined) {
    const seconds = Number.parseFloat(controls.sleep);
    if (Number.isFinite(seconds) && seconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }

  if (controls.stderr !== undefined) {
    process.stderr.write(`${controls.stderr}\n`);
  }

  if (controls.outText !== undefined) {
    const outIndex = args.indexOf('-o');
    if (outIndex === -1 || outIndex + 1 >= args.length) {
      process.stderr.write('fake-cli: no program argument after -o to receive --fake-out-text\n');
      process.exitCode = 9;
      return;
    }
    const target = args[outIndex + 1];
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, controls.outText, 'utf8');
  }

  if (controls.write !== undefined) {
    const target = path.resolve(process.cwd(), controls.write);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'written by fake-cli', 'utf8');
  }

  if (controls.session !== undefined) {
    process.stdout.write(`session_id: ${controls.session}\n`);
  }

  if (controls.stdout !== undefined) {
    process.stdout.write(`${controls.stdout}\n`);
  } else {
    const report = {
      args,
      stdin,
      cwd: process.cwd(),
      files: collectFiles(args),
    };
    if (controls.reportFile !== undefined) {
      fs.mkdirSync(path.dirname(path.resolve(controls.reportFile)), { recursive: true });
      fs.writeFileSync(path.resolve(controls.reportFile), JSON.stringify(report), 'utf8');
    } else {
      process.stdout.write(`FAKE-REPORT ${JSON.stringify(report)}\n`);
    }
  }

  if (controls.exit !== undefined) {
    const code = Number.parseInt(controls.exit, 10);
    if (Number.isInteger(code)) {
      process.exitCode = code;
    }
  }
}

await main();
