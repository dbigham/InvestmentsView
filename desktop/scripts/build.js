const { spawnSync } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..', '..');
const clientDir = path.join(rootDir, 'client');
const serverDir = path.join(rootDir, 'server');
const desktopDir = path.join(rootDir, 'desktop');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run('npm', ['install'], clientDir);
run('npm', ['run', 'build'], clientDir);
run('npm', ['install'], serverDir);
run('npm', ['install'], desktopDir);
run('npm', ['run', 'dist'], desktopDir);
