/**
 * Purpose: Installs or uninstalls claude-workforce skills, agents, and optional statusline
 *          into the Claude Code directory (<home>/.claude).
 *
 * Usage:
 *   node install.mjs [--src <repo root>] [--home <dir>] [--dry-run] [--force] [--statusline] [--uninstall]
 *
 * Output:
 *   Prints one line per file (installed / unchanged / kept yours / backed up),
 *   statusLine notifications, doctor check output from worker.mjs doctor,
 *   or plan details in dry-run mode. Errors are reported to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEXT_EXTS = new Set(['.md', '.json', '.mjs', '.csv', '.txt']);

function isTextFile(filePath) {
  return TEXT_EXTS.has(path.extname(filePath).toLowerCase());
}

function parseArgs(args) {
  const options = {
    src: null,
    home: null,
    dryRun: false,
    force: false,
    statusline: false,
    uninstall: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--src') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        console.error('Error: --src requires a directory path');
        process.exit(1);
      }
      options.src = args[++i];
    } else if (arg.startsWith('--src=')) {
      options.src = arg.slice('--src='.length);
    } else if (arg === '--home') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        console.error('Error: --home requires a directory path');
        process.exit(1);
      }
      options.home = args[++i];
    } else if (arg.startsWith('--home=')) {
      options.home = arg.slice('--home='.length);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--statusline') {
      options.statusline = true;
    } else if (arg === '--uninstall') {
      options.uninstall = true;
    } else {
      console.error(`Error: Unknown flag "${arg}"`);
      process.exit(1);
    }
  }

  return options;
}

function canonKey(filePath) {
  const norm = path.normalize(path.resolve(filePath)).replace(/\\/g, '/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function isProtectedDataFile(filePath, claudeDir) {
  const normFile = path.resolve(filePath);
  const loDir = path.join(claudeDir, 'skills', 'lean-orchestrator');
  const target1 = path.join(loDir, 'routing.json');
  const target2 = path.join(loDir, 'LESSONS.md');
  const target3 = path.join(loDir, 'METRICS.csv');

  const c = canonKey(normFile);
  return c === canonKey(target1) || c === canonKey(target2) || c === canonKey(target3);
}

function removeEmptyDirs(dir, stopDir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const full = path.join(dir, entry.name);
      removeEmptyDirs(full, stopDir);
    }
  }
  if (dir !== stopDir) {
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {}
  }
}

function collectFiles(srcDir, claudeDir, includeStatusline) {
  const files = [];

  // 1. skills/<name>/...
  const srcSkills = path.join(srcDir, 'skills');
  function walkSkills(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.install-manifest.json') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkSkills(full);
      } else if (entry.isFile()) {
        const rel = path.relative(srcDir, full);
        const dest = path.join(claudeDir, rel);
        files.push({ src: full, dest });
      }
    }
  }
  walkSkills(srcSkills);

  // 2. agents/*.md
  const srcAgents = path.join(srcDir, 'agents');
  if (fs.existsSync(srcAgents) && fs.statSync(srcAgents).isDirectory()) {
    const entries = fs.readdirSync(srcAgents, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const full = path.join(srcAgents, entry.name);
        const dest = path.join(claudeDir, 'agents', entry.name);
        files.push({ src: full, dest });
      }
    }
  }

  // 3. statusline/usage-snapshot.mjs if requested
  if (includeStatusline) {
    const snapshotSrc = path.join(srcDir, 'statusline', 'usage-snapshot.mjs');
    if (fs.existsSync(snapshotSrc) && fs.statSync(snapshotSrc).isFile()) {
      const dest = path.join(claudeDir, 'usage-snapshot.mjs');
      files.push({ src: snapshotSrc, dest });
    }
  }

  return files;
}

let backupDirName = null;
function getBackupFolder(claudeDir) {
  if (!backupDirName) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const min = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    backupDirName = `claude-workforce-${yyyy}${mm}${dd}-${hh}${min}${ss}`;
  }
  return path.join(claudeDir, 'backups', backupDirName);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const defaultHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!options.home && !defaultHome) {
    console.error('Error: Could not determine home directory');
    process.exit(1);
  }
  const homeDir = path.resolve(options.home || defaultHome);
  const claudeDir = path.join(homeDir, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const skillsDirFwd = skillsDir.replace(/\\/g, '/');
  const manifestPath = path.join(skillsDir, 'lean-orchestrator', '.install-manifest.json');

  // Uninstall mode
  if (options.uninstall) {
    if (!fs.existsSync(manifestPath)) {
      console.log('Nothing was installed (no manifest found).');
      process.exit(0);
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      console.log('Nothing was installed (invalid manifest).');
      process.exit(0);
    }

    const files = Array.isArray(manifest.files) ? manifest.files : [];
    for (const file of files) {
      if (isProtectedDataFile(file, claudeDir)) {
        console.log(`kept: ${file}`);
      } else {
        if (fs.existsSync(file)) {
          try {
            fs.unlinkSync(file);
            console.log(`removed: ${file}`);
          } catch (err) {
            console.error(`Error removing ${file}: ${err.message}`);
          }
        }
      }
    }

    if (fs.existsSync(manifestPath)) {
      try {
        fs.unlinkSync(manifestPath);
        console.log(`removed: ${manifestPath}`);
      } catch (err) {
        console.error(`Error removing manifest: ${err.message}`);
      }
    }

    removeEmptyDirs(claudeDir, homeDir);
    process.exit(0);
  }

  // Install mode - validate source directory
  const defaultSrc = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(options.src || defaultSrc);

  try {
    const stat = fs.statSync(srcDir);
    if (!stat.isDirectory()) {
      console.error(`Error: source path "${srcDir}" is not a directory`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: unreadable source directory "${srcDir}": ${err.message}`);
    process.exit(1);
  }

  const srcSkillsDir = path.join(srcDir, 'skills');
  if (!fs.existsSync(srcSkillsDir) || !fs.statSync(srcSkillsDir).isDirectory()) {
    console.error(`Error: source skills/ folder missing in "${srcDir}"`);
    process.exit(1);
  }

  const filesToInstall = collectFiles(srcDir, claudeDir, options.statusline);

  // Dry run
  if (options.dryRun) {
    for (const item of filesToInstall) {
      console.log(`install: ${item.dest}`);
    }
    process.exit(0);
  }

  // Read previous manifest if present
  const previousManifestFiles = new Map();
  if (fs.existsSync(manifestPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(prev.files)) {
        for (const f of prev.files) {
          if (typeof f === 'string') {
            const resolved = path.resolve(f);
            previousManifestFiles.set(canonKey(resolved), resolved);
          }
        }
      }
    } catch {}
  }

  const newManifestFiles = new Map();

  for (const item of filesToInstall) {
    const destPath = path.resolve(item.dest);
    const destKey = canonKey(destPath);
    const isText = isTextFile(item.src);

    let newContent;
    let newBuffer;
    if (isText) {
      const raw = fs.readFileSync(item.src, 'utf8');
      newContent = raw.replaceAll('{{SKILLS_DIR}}', skillsDirFwd);
      newBuffer = Buffer.from(newContent, 'utf8');
    } else {
      newBuffer = fs.readFileSync(item.src);
    }

    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, isText ? newContent : newBuffer);
      console.log(`installed: ${destPath}`);
      newManifestFiles.set(destKey, destPath);
    } else {
      let isIdentical = false;
      if (isText) {
        const existing = fs.readFileSync(destPath, 'utf8');
        isIdentical = existing === newContent;
      } else {
        const existing = fs.readFileSync(destPath);
        isIdentical = existing.equals(newBuffer);
      }

      if (isIdentical) {
        console.log(`unchanged: ${destPath}`);
        newManifestFiles.set(destKey, destPath);
      } else {
        const isProtected = isProtectedDataFile(destPath, claudeDir);
        if (isProtected) {
          console.log(`kept yours: ${destPath}`);
          if (previousManifestFiles.has(destKey)) {
            newManifestFiles.set(destKey, destPath);
          }
        } else if (!options.force) {
          console.log(`kept yours: ${destPath}`);
          if (previousManifestFiles.has(destKey)) {
            newManifestFiles.set(destKey, destPath);
          }
        } else {
          // --force: back up then overwrite
          const backupFolder = getBackupFolder(claudeDir);
          const rel = path.relative(claudeDir, destPath);
          const backupPath = path.join(backupFolder, rel);
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          fs.copyFileSync(destPath, backupPath);

          fs.writeFileSync(destPath, isText ? newContent : newBuffer);
          console.log(`backed up: ${destPath}`);
          newManifestFiles.set(destKey, destPath);
        }
      }
    }
  }

  // Merge remaining files from previous manifest that still exist on disk
  for (const [key, filePath] of previousManifestFiles) {
    if (!newManifestFiles.has(key)) {
      if (fs.existsSync(filePath)) {
        newManifestFiles.set(key, filePath);
      }
    }
  }

  // Handle --statusline settings.json configuration
  if (options.statusline) {
    const snapshotScript = path.join(claudeDir, 'usage-snapshot.mjs');
    const snapshotFwd = snapshotScript.replace(/\\/g, '/');
    const settingsPath = path.join(claudeDir, 'settings.json');

    if (!fs.existsSync(settingsPath)) {
      const settings = {
        statusLine: {
          type: 'command',
          command: `node "${snapshotFwd}"`,
        },
      };
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    } else {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      let parsed = null;
      let valid = false;
      try {
        parsed = JSON.parse(raw);
        valid = true;
      } catch {
        console.warn(`Warning: ${settingsPath} is not valid JSON, leaving untouched`);
      }

      if (valid && parsed && typeof parsed === 'object') {
        if ('statusLine' in parsed && parsed.statusLine !== undefined) {
          console.log('kept your statusLine');
        } else {
          const backupFolder = getBackupFolder(claudeDir);
          fs.mkdirSync(backupFolder, { recursive: true });
          fs.writeFileSync(path.join(backupFolder, 'settings.json'), raw);

          parsed.statusLine = {
            type: 'command',
            command: `node "${snapshotFwd}"`,
          };
          fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n');
        }
      }
    }
  }

  // Write manifest
  let version = '0.0.0';
  const pkgPath = path.join(srcDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
        version = pkg.version.trim();
      }
    } catch {}
  }

  const manifestData = {
    version,
    installedAt: new Date().toISOString(),
    files: Array.from(newManifestFiles.values()).sort(),
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2) + '\n');

  // Run doctor check at the end of install
  const doctorScript = path.join(claudeDir, 'skills', 'lean-orchestrator', 'tools', 'worker.mjs');
  if (fs.existsSync(doctorScript)) {
    try {
      const res = spawnSync(process.execPath, [doctorScript, 'doctor'], {
        encoding: 'utf8',
        env: process.env,
      });
      if (res.stdout) {
        process.stdout.write(res.stdout);
      }
      if (res.stderr) {
        process.stderr.write(res.stderr);
      }
      if (res.status !== 0 || res.error) {
        console.log('Note: doctor check reported non-zero status (ignored)');
      }
    } catch (err) {
      console.log(`Note: doctor check failed: ${err.message} (ignored)`);
    }
  } else {
    console.log('Note: worker.mjs not found, skipping doctor check');
  }
}

main();
