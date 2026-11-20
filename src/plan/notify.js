// Windows értesítés (toast) PowerShellből, külső modul nélkül.
// Késleltetve és a háttérben indul, hogy a folyamatindítás ne zavarja a pontos időzítést.

import { spawn } from 'node:child_process';

const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const esc = (s) => String(s).replace(/'/g, "''");

export function notify(title, body, { delayMs = 150 } = {}) {
  if (process.platform !== 'win32') return;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$x = $t.GetElementsByTagName("text")',
    `$x.Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) > $null`,
    `$x.Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) > $null`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`,
  ].join('; ');
  setTimeout(() => {
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } catch { /* az értesítés nem kritikus */ }
  }, delayMs);
}
