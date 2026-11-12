export const OWNED_CAPTION_ACTIVATION_SCRIPT = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OwnedCaptionActivation {
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mouse; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint n,INPUT[] input,int size);
 [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint msg,IntPtr wp,IntPtr lp,uint flags,uint timeout,out UIntPtr result);
 public static bool IsOwnedCaption(IntPtr target,uint pid,int x,int y) {
   uint actual; GetWindowThreadProcessId(target,out actual);
   if(actual!=pid || !IsWindowVisible(target) || IsIconic(target)) return false;
   POINT pt=new POINT { X=x,Y=y };
   IntPtr hit=WindowFromPoint(pt);
   if(GetAncestor(hit,2)!=target) return false;
   GetWindowThreadProcessId(hit,out actual);
   if(actual!=pid) return false;
   UIntPtr result;
   long packed=((long)(ushort)y<<16)|(ushort)x;
   if(SendMessageTimeout(target,0x84,IntPtr.Zero,new IntPtr(packed),2,200,out result)==IntPtr.Zero) return false;
   return result.ToUInt64()==2;
 }
 public static uint ReleaseExpected,ReleaseCount;
 public static uint ClickCaption(IntPtr target,uint pid,int x,int y) {
   ReleaseExpected=0; ReleaseCount=0;
   if(!IsOwnedCaption(target,pid,x,y)) return 0;
   int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
   if(width<=1 || height<=1 || x<left || y<top || x>=left+width || y>=top+height) return 0;
   INPUT[] inputs=new INPUT[3];
   inputs[0].mouse.dx=(int)Math.Round((x-left)*65535.0/(width-1));
   inputs[0].mouse.dy=(int)Math.Round((y-top)*65535.0/(height-1));
   inputs[0].mouse.dwFlags=0x0001|0x8000|0x4000;
   inputs[1].mouse.dwFlags=0x0002;
   inputs[2].mouse.dwFlags=0x0004;
   uint sent=SendInput(3,inputs,Marshal.SizeOf(typeof(INPUT)));
   if(sent==2) { ReleaseExpected=1; INPUT[] release=new INPUT[1]; release[0].mouse.dwFlags=0x0004; ReleaseCount=SendInput(1,release,Marshal.SizeOf(typeof(INPUT))); }
   return sent;
 }
}
"@
function Invoke-OwnedCaptionActivation([uint32]$TargetPid,[long]$TargetHwnd) {
$target=[IntPtr]$TargetHwnd
$bounds=New-Object OwnedCaptionActivation+RECT
$found=$false; $sent=[uint32]0; $clickX=0; $clickY=0
if([OwnedCaptionActivation]::GetWindowRect($target,[ref]$bounds)) {
 foreach($offsetY in @(12,20,28)) {
  for($x=$bounds.Right-160;$x -ge $bounds.Left+32;$x-=48) {
   $y=$bounds.Top+$offsetY
   if([OwnedCaptionActivation]::IsOwnedCaption($target,$TargetPid,$x,$y)) {
    $found=$true; $clickX=$x; $clickY=$y
    $sent=[OwnedCaptionActivation]::ClickCaption($target,$TargetPid,$x,$y)
    break
   }
  }
  if($found){break}
 }
}
return [pscustomobject]@{visibleOwnedCaption=$found;x=$clickX;y=$clickY;mouseEventsSent=$sent;releaseExpected=[OwnedCaptionActivation]::ReleaseExpected;released=[OwnedCaptionActivation]::ReleaseCount;foregroundAfter=[OwnedCaptionActivation]::GetForegroundWindow().ToInt64()}
}
`
