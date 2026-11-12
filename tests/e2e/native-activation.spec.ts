import { execFileSync } from 'node:child_process'
import { chromium, expect, test } from '@playwright/test'
import { OWNED_CAPTION_ACTIVATION_SCRIPT } from './native-activation'

test('原生窗口激活：拒绝错误 PID、无效窗口及非标题栏，正常单击仅激活所属窗口', async () => {
  test.skip(process.platform !== 'win32', 'Windows native window activation requires Win32')
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1100, height: 760 },
  })
  try {
    const page = await context.newPage()
    await page.goto('data:text/html,<title>Owned activation fixture</title><input value="Synthetic draft">')
    const cdp = await context.browser()!.newBrowserCDPSession()
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    await cdp.detach()
    const targetPid = processInfo.find((entry) => entry.type === 'browser')?.id
    expect(targetPid).toBeDefined()
    const script = `
$ErrorActionPreference='Stop'
${OWNED_CAPTION_ACTIVATION_SCRIPT}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]${targetPid})
$windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
$target=[IntPtr]::Zero
foreach($window in $windows) {
  if($window.Current.Name.Contains('Owned activation fixture')) { $target=[IntPtr]$window.Current.NativeWindowHandle; break }
}
if($target -eq [IntPtr]::Zero){throw 'Missing owned test window'}
$before=[OwnedCaptionActivation]::GetForegroundWindow().ToInt64()
$wrongPid=Invoke-OwnedCaptionActivation -TargetPid ${process.pid} -TargetHwnd $target.ToInt64()
$invalidWindow=Invoke-OwnedCaptionActivation -TargetPid ${targetPid} -TargetHwnd 0
$bounds=New-Object OwnedCaptionActivation+RECT
if(-not [OwnedCaptionActivation]::GetWindowRect($target,[ref]$bounds)){throw 'Missing window bounds'}
$nonCaption=[OwnedCaptionActivation]::ClickCaption($target,${targetPid},[int](($bounds.Left+$bounds.Right)/2),[int](($bounds.Top+$bounds.Bottom)/2))
$afterRejected=[OwnedCaptionActivation]::GetForegroundWindow().ToInt64()
$positive=Invoke-OwnedCaptionActivation -TargetPid ${targetPid} -TargetHwnd $target.ToInt64()
[pscustomobject]@{target=$target.ToInt64();before=$before;afterRejected=$afterRejected;wrongPid=$wrongPid;invalidWindow=$invalidWindow;nonCaptionEvents=$nonCaption;positive=$positive}|ConvertTo-Json -Depth 5 -Compress
`
    const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 25_000, windowsHide: true,
    })) as {
      target: number; before: number; afterRejected: number
      wrongPid: { visibleOwnedCaption: boolean; mouseEventsSent: number }
      invalidWindow: { visibleOwnedCaption: boolean; mouseEventsSent: number }
      nonCaptionEvents: number
      positive: { visibleOwnedCaption: boolean; mouseEventsSent: number; foregroundAfter: number }
    }
    await test.info().attach('native-activation-results', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' })
    expect(result.wrongPid).toMatchObject({ visibleOwnedCaption: false, mouseEventsSent: 0 })
    expect(result.invalidWindow).toMatchObject({ visibleOwnedCaption: false, mouseEventsSent: 0 })
    expect(result.nonCaptionEvents).toBe(0)
    expect(result.afterRejected).toBe(result.before)
    expect(result.positive).toMatchObject({ visibleOwnedCaption: true, mouseEventsSent: 3, foregroundAfter: result.target })
    await expect(page.locator('input')).toHaveValue('Synthetic draft')
  } finally {
    await context.close()
  }
})
