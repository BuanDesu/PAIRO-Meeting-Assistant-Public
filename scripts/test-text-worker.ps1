# Controlled, generated input only. Never reads another application's content or clicks outside this form.
$ErrorActionPreference = 'Stop'
$assemblies = @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')
foreach ($assembly in $assemblies) { Add-Type -AssemblyName $assembly }
$workerSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../electron/text-worker.cs'), [Text.Encoding]::UTF8)
$fixture = @'
public class PairoHotkeyForm : System.Windows.Forms.Form {
    public int Num3Events;
    protected override void WndProc(ref System.Windows.Forms.Message message) {
        if(message.Msg==0x312&&message.WParam.ToInt32()==73)Num3Events++;
        base.WndProc(ref message);
    }
}
public class PairoTextFixture {
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetForegroundWindow(System.IntPtr value);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool RegisterHotKey(System.IntPtr value,int id,uint modifiers,uint key);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool UnregisterHotKey(System.IntPtr value,int id);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern short GetKeyState(int key);
    static PairoHotkeyForm form;
    static System.Windows.Forms.RichTextBox box, other;
    static System.Windows.Forms.TextBox password;
    static System.Collections.Generic.Dictionary<string, object> results = new System.Collections.Generic.Dictionary<string, object>();
    static object Call(string action, params object[] pairs) {
        var value = new System.Collections.Generic.Dictionary<string, object>(); value["action"] = action;
        for (int i=0;i<pairs.Length;i+=2) value[(string)pairs[i]]=pairs[i+1];
        try { return typeof(PairoTextWorker).GetMethod("Execute", System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic).Invoke(null,new object[]{value}); }
        catch (System.Reflection.TargetInvocationException e) { throw e.InnerException; }
    }
    static T UI<T>(System.Func<T> action) { return (T)form.Invoke(action); }
    static void Edit(string value) {
        int handle=UI(()=>{ box.ReadOnly=false; box.Text=value; box.Focus(); box.SelectAll(); return box.Handle.ToInt32(); });
        var watch=System.Diagnostics.Stopwatch.StartNew();
        while(watch.ElapsedMilliseconds<1500) {
            if(GetForegroundWindow()!=UI(()=>form.Handle))throw new System.Exception("focus");
            var current=System.Windows.Automation.AutomationElement.FocusedElement;
            if(current!=null&&current.Current.NativeWindowHandle==handle)return;
            System.Threading.Thread.Sleep(30);
        }
        throw new System.Exception("Generated fixture focus was not ready");
    }
    static object lastArm;
    static string Prepare() { lastArm=Call("arm"); return (string)lastArm.GetType().GetProperty("token").GetValue(lastArm,null); }
    static void Type(string token,string value,int chinese,int english) { Call("type","token",token,"text",value,"chineseCpm",chinese,"englishWpm",english); }
    static void Check(bool value,string label) { if(!value)throw new System.Exception(label); results[label]=true; }
    static void Expect(string code,System.Action action) { try{action();}catch(System.Exception error){if(error.Message==code)return;throw;} throw new System.Exception("Expected "+code); }
    static void NativeKeys(params int[] triples) {
        var key=typeof(PairoTextWorker).GetMethod("Key",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic);
        var keys=System.Array.CreateInstance(key.ReturnType,triples.Length/3);
        for(int i=0;i<triples.Length;i+=3)keys.SetValue(key.Invoke(null,new object[]{(ushort)triples[i],(ushort)triples[i+1],(uint)triples[i+2]}),i/3);
        typeof(PairoTextWorker).GetMethod("Send",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic).Invoke(null,new object[]{keys});
    }
    public static void Run(string output) {
        System.IntPtr previous=GetForegroundWindow();
        form=new PairoHotkeyForm{Text="PAIRO - isolated generated text input validation",Width=640,Height=320,StartPosition=System.Windows.Forms.FormStartPosition.CenterScreen};
        box=new System.Windows.Forms.RichTextBox{Dock=System.Windows.Forms.DockStyle.Top,Height=150};
        other=new System.Windows.Forms.RichTextBox{Dock=System.Windows.Forms.DockStyle.Top,Height=50};
        password=new System.Windows.Forms.TextBox{Dock=System.Windows.Forms.DockStyle.Bottom,UseSystemPasswordChar=true};
        form.Controls.Add(other);form.Controls.Add(box);form.Controls.Add(password);
        int enters=0, mainNext=0; box.KeyDown+=(sender,e)=>{if(e.KeyCode==System.Windows.Forms.Keys.Enter)enters++;if(e.KeyCode==System.Windows.Forms.Keys.Next)mainNext++;};
        form.Shown+=(sender,e)=>{
            form.Activate();box.Focus();
            var thread=new System.Threading.Thread(()=>{
                try {
                    System.Threading.Thread.Sleep(200);
                    Check(GetForegroundWindow()==UI(()=>form.Handle),"fixtureOwnsForeground");
                    Edit("generated selected question");
                    var selected=Call("copy");
                    Check((string)selected.GetType().GetProperty("text").GetValue(selected,null)=="generated selected question","selectionRead");
                    Edit(""); string first=Prepare();
                    var watch=System.Diagnostics.Stopwatch.StartNew();
                    Type(first,"\u4e2d\u6587abc",60,90); System.Threading.Thread.Sleep(100); watch.Stop();
                    Check(UI(()=>box.Text)=="\u4e2d\u6587abc","unicodeTyped");
                    Check(watch.ElapsedMilliseconds>=2350,"defaultPacing");results["defaultElapsedMs"]=watch.ElapsedMilliseconds;
                    Edit(""); string fast=Prepare(); watch.Restart(); Type(fast,"\u4e2d\u6587abc",600,300);System.Threading.Thread.Sleep(100);watch.Stop();
                    Check(UI(()=>box.Text)=="\u4e2d\u6587abc","customSpeedTyped");Check(watch.ElapsedMilliseconds<1800,"customPacing");results["customElapsedMs"]=watch.ElapsedMilliseconds;
                    Edit(""); string newline=Prepare();Type(newline,"a\nb",600,300);System.Threading.Thread.Sleep(100);
                    Check(UI(()=>box.Text)=="a b","newlinesBecomeSpaces");Check(enters==0,"noEnterSubmission");
                    Edit(""); string changed=Prepare();UI(()=>{other.Focus();return true;});Expect("focus",()=>Type(changed,"must not type",60,90));Check(UI(()=>other.Text)=="","focusChangeStops");
                    Edit("");string during=Prepare();var timer=new System.Threading.Timer(_=>UI(()=>{other.Focus();return true;}),null,400,System.Threading.Timeout.Infinite);
                    Expect("focus",()=>Type(during,"abcdefghijk",60,90));timer.Dispose();Check(UI(()=>box.Text.Length)<11&&UI(()=>other.Text)=="","midInputFocusChangeStops");
                    Edit("");UI(()=>{box.ReadOnly=true;return true;});Expect("target",()=>Prepare());results["readOnlyRejected"]=true;
                    UI(()=>{password.Focus();return true;});Expect("target",()=>Prepare());results["passwordRejected"]=true;
                    Edit("");string stale=Prepare();typeof(PairoTextWorker).GetField("armed",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic).SetValue(null,System.DateTime.UtcNow.AddSeconds(-11));
                    Expect("expired",()=>Type(stale,"stale",60,90));results["expiredTargetRejected"]=true;
                    Check(UI(()=>RegisterHotKey(form.Handle,73,4,0x63)),"shiftNum3Registered");
                    bool numLock=(GetKeyState(0x90)&1)!=0;
                    try {
                        if(!numLock){NativeKeys(0x90,0,0,0x90,0,2);System.Threading.Thread.Sleep(100);}
                        Check(GetForegroundWindow()==UI(()=>form.Handle),"hotkeyFixtureOwnsForeground");
                        int actual=0;
                        PairoNumpadHook.Start(action=>{if(action=="type-answer")System.Threading.Interlocked.Increment(ref actual);});
                        var binding=new System.Collections.Generic.Dictionary<string,object>();binding["action"]="type-answer";binding["digit"]=3;binding["modifiers"]=4;
                        PairoNumpadHook.Configure(new object[]{binding});
                        NativeKeys(0x10,0,0,0,0x51,8,0,0x51,10,0x10,0,2);System.Threading.Thread.Sleep(200);
                        Check(actual==1,"physicalShiftNum3Fires");Check(UI(()=>form.Num3Events)==0,"noDuplicateHotkey");
                        NativeKeys(0,0x2a,8,0,0x51,8,0,0x51,10,0,0x2a,10);System.Threading.Thread.Sleep(100);
                        Check(actual==2,"hardwareShiftScanFires");
                        NativeKeys(0,0x2a,8,0,0x51,9,0,0x51,11,0,0x2a,10);System.Threading.Thread.Sleep(100);
                        Check(actual==2&&UI(()=>mainNext)>0,"mainPageDownUnaffected");
                        PairoNumpadHook.Configure(new object[0]);
                        NativeKeys(0x10,0,0,0,0x51,8,0,0x51,10,0x10,0,2);System.Threading.Thread.Sleep(100);
                        Check(actual==2,"disabledHookPassesThrough");
                    }finally{PairoNumpadHook.Configure(new object[0]);UI(()=>UnregisterHotKey(form.Handle,73));if(!numLock&&GetForegroundWindow()==UI(()=>form.Handle))NativeKeys(0x90,0,0,0x90,0,2);}
                    results["passed"]=true;
                }catch(System.Exception error){results["passed"]=false;results["failure"]=error.Message;}
                finally {
                    var json=new System.Web.Script.Serialization.JavaScriptSerializer();System.IO.File.WriteAllText(output,json.Serialize(results));
                    UI(()=>{if(GetForegroundWindow()==form.Handle)SetForegroundWindow(previous);form.Close();return true;});
                }
            });thread.SetApartmentState(System.Threading.ApartmentState.STA);thread.Start();
        };
        System.Windows.Forms.Application.Run(form);
    }
}
'@
Add-Type -TypeDefinition ($workerSource + "`n" + $fixture) -ReferencedAssemblies $assemblies
$qaDirectory = Join-Path $PSScriptRoot '../release/text-workflow-qa'
[IO.Directory]::CreateDirectory($qaDirectory) | Out-Null
$resultPath = [IO.Path]::GetFullPath((Join-Path $qaDirectory 'native-input.json'))
[PairoTextFixture]::Run($resultPath)
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
$result | ConvertTo-Json -Compress
if (-not $result.passed) { exit 1 }
