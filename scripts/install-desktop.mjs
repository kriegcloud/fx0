// Install the workstation launcher for this checkout; no root or autostart.
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const home = homedir()
const root = path.resolve(import.meta.dirname, '..')
const bin = path.join(home, '.local/bin')
const applications = path.join(home, '.local/share/applications')
const units = path.join(home, '.config/systemd/user')
const icons = path.join(home, '.local/share/icons/hicolor/192x192/apps')
const state = path.join(home, '.local/state/fx0')
const desktop = execFileSync('/usr/bin/xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' }).trim()
for (const directory of [bin, applications, units, icons, state, desktop]) await mkdir(directory, { recursive: true })
const env = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`,
}
const managerPath = execFileSync('/usr/bin/systemctl', ['--user', 'show-environment'], { env, encoding: 'utf8' })
  .split('\n').find(line => line.startsWith('PATH='))?.slice(5) || `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const unitQuote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`
const desktopQuote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$').replaceAll('%', '%%')}"`
const launcher = path.join(bin, 'fx0-launch')
await writeFile(launcher, `#!/bin/bash
set -eu
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
exec 9>"$XDG_RUNTIME_DIR/fx0-desktop.lock"
if ! /usr/bin/flock -n 9; then
  /usr/bin/notify-send --app-name=fx0 --icon=fx0 fx0 'A build is already running. The app will open when it is ready.'
  exit 0
fi
${shellQuote(process.execPath)} ${shellQuote(path.join(root, 'scripts/desktop-launch.mjs'))}
`, { mode: 0o755 })
await chmod(launcher, 0o755)
await writeFile(path.join(units, 'fx0-local.service'), `[Unit]
Description=fx0 local production server with CLIProxyAPI
After=cli-proxy-api.service

[Service]
Type=simple
WorkingDirectory=${root.replaceAll('%', '%%')}
ExecStart=${unitQuote(process.execPath)} --env-file-if-exists=.env.local scripts/local-dev.mjs --production
Environment=${unitQuote(`PATH=${path.dirname(process.execPath)}:${managerPath}`)}
Environment=FX0_LOCAL_PORT=3000
Environment=${unitQuote(`FX0_LOCAL_DATA_DIR=${path.join(root, '.local')}`)}
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
StandardOutput=append:${state}/server.log
StandardError=append:${state}/server.log
`)
const entry = `[Desktop Entry]
Version=1.0
Type=Application
Name=fx0
GenericName=AI Design Studio
Comment=Build fx0 and open its local AI design app
Exec=${desktopQuote(launcher)}
Icon=fx0
Terminal=false
StartupNotify=false
StartupWMClass=fx0
Categories=Development;
Keywords=fx0;Beep;Kimi;AI;Design;CLIProxyAPI;
`
const menuEntry = path.join(applications, 'fx0.desktop')
await writeFile(menuEntry, entry)
await copyFile(path.join(root, 'app/icon.png'), path.join(icons, 'fx0.png'))
await copyFile(menuEntry, path.join(desktop, 'fx0.desktop'))
await chmod(path.join(desktop, 'fx0.desktop'), 0o755)
execFileSync('/usr/bin/desktop-file-validate', [menuEntry], { stdio: 'inherit' })
execFileSync('/usr/bin/systemctl', ['--user', 'daemon-reload'], { env, stdio: 'inherit' })
execFileSync('/usr/bin/kbuildsycoca6', ['--noincremental'], { env, stdio: 'inherit' })
console.log(`Installed KDE search entry: ${menuEntry}\nDesktop icon: ${desktop}/fx0.desktop\nLaunch command: ${launcher}`)
